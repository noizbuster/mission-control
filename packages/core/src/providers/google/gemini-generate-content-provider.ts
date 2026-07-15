import type { ProviderCredentialResolver } from '../credential-resolver';
import { type ProviderAdapter, ProviderTurnError } from '../provider-turn-types';
import { mapGeminiProviderError } from './gemini-generate-content-errors';
import {
    createGeminiGenerateContentMappingState,
    mapGeminiGenerateContentStreamEvent,
} from './gemini-generate-content-mapper';
import {
    apiKeyForGeminiCredential,
    createGeminiGenerateContentTransportRequest,
    resolveGeminiCredential,
} from './gemini-generate-content-request';
import {
    type GeminiGenerateContentTransport,
    GeminiGenerateContentTransportError,
    type GeminiGenerateContentTransportRequest,
} from './gemini-generate-content-transport';

export { createNodeGeminiGenerateContentTransport } from './gemini-generate-content-http-transport';
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
