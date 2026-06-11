import type { ProviderCredentialResolver } from '../credential-resolver.js';
import { type ProviderAdapter, ProviderTurnError } from '../provider-turn-types.js';
import { mapGeminiProviderError } from './gemini-generate-content-errors.js';
import {
    createGeminiGenerateContentMappingState,
    mapGeminiGenerateContentStreamEvent,
} from './gemini-generate-content-mapper.js';
import {
    apiKeyForGeminiCredential,
    createGeminiGenerateContentTransportRequest,
    resolveGeminiCredential,
} from './gemini-generate-content-request.js';
import {
    type GeminiGenerateContentTransport,
    GeminiGenerateContentTransportError,
    type GeminiGenerateContentTransportRequest,
} from './gemini-generate-content-transport.js';

export { createNodeGeminiGenerateContentTransport } from './gemini-generate-content-http-transport.js';
export type { GeminiGenerateContentTransport, GeminiGenerateContentTransportRequest };
export { GeminiGenerateContentTransportError };

export type GeminiGenerateContentProviderOptions = {
    readonly credentialResolver: ProviderCredentialResolver;
    readonly transport: GeminiGenerateContentTransport;
    readonly baseEndpoint?: string;
};

export function createGeminiGenerateContentProvider(options: GeminiGenerateContentProviderOptions): ProviderAdapter {
    return {
        async *streamTurn(request, context) {
            try {
                const credential = await resolveGeminiCredential(options.credentialResolver, request.providerID);
                const apiKey = apiKeyForGeminiCredential(credential);
                const transportRequest = createGeminiGenerateContentTransportRequest({
                    request,
                    apiKey,
                    signal: context.signal,
                    ...(options.baseEndpoint !== undefined ? { baseEndpoint: options.baseEndpoint } : {}),
                });
                const state = createGeminiGenerateContentMappingState(request.requestId);

                for await (const rawEvent of options.transport.stream(transportRequest)) {
                    for (const chunk of mapGeminiGenerateContentStreamEvent(rawEvent, state)) {
                        yield chunk;
                    }
                }
            } catch (error) {
                throw new ProviderTurnError(mapGeminiProviderError(error, options.credentialResolver));
            }
        },
    };
}
