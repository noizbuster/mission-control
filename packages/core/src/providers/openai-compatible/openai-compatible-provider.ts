import type { ProviderCredentialResolver } from '../credential-resolver';
import { type ProviderAdapter, ProviderTurnError } from '../provider-turn-types';
import { mapOpenAICompatibleProviderError } from './openai-compatible-errors';
import { createOpenAICompatibleMappingState, mapOpenAICompatibleStreamEvent } from './openai-compatible-mapper';
import {
    bearerTokenForOpenAICompatibleCredential,
    createOpenAICompatibleTransportRequest,
    resolveOpenAICompatibleCredential,
} from './openai-compatible-request';
import { OPENAI_COMPATIBLE_PROVIDER_SPECS, type OpenAICompatibleProviderSpec } from './openai-compatible-specs';
import {
    type OpenAICompatibleTransport,
    OpenAICompatibleTransportError,
    type OpenAICompatibleTransportRequest,
} from './openai-compatible-transport';

export { createNodeOpenAICompatibleTransport } from './openai-compatible-http-transport';
export type { OpenAICompatibleProviderSpec, OpenAICompatibleTransport, OpenAICompatibleTransportRequest };
export { OPENAI_COMPATIBLE_PROVIDER_SPECS, OpenAICompatibleTransportError };

export type OpenAICompatibleProviderOptions = {
    readonly credentialResolver: ProviderCredentialResolver;
    readonly transport: OpenAICompatibleTransport;
    readonly endpoint?: string;
};

export function createOpenAICompatibleProvider(options: OpenAICompatibleProviderOptions): ProviderAdapter {
    return {
        async *streamTurn(request, context) {
            try {
                const credential = await resolveOpenAICompatibleCredential(
                    options.credentialResolver,
                    request.providerID,
                );
                const bearerToken = bearerTokenForOpenAICompatibleCredential(credential);
                const transportRequest = createOpenAICompatibleTransportRequest({
                    request,
                    bearerToken,
                    signal: context.signal,
                    ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
                });
                const state = createOpenAICompatibleMappingState(request.requestId, request.providerID);

                for await (const rawEvent of options.transport.stream(transportRequest)) {
                    for (const chunk of mapOpenAICompatibleStreamEvent(
                        rawEvent,
                        state,
                        options.credentialResolver.redactForOutput,
                    )) {
                        yield chunk;
                    }
                }
            } catch (error) {
                throw new ProviderTurnError(mapOpenAICompatibleProviderError(error, options.credentialResolver));
            }
        },
    };
}
