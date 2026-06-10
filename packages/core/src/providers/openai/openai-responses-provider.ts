import type { ProviderCredentialResolver } from '../credential-resolver.js';
import { type ProviderAdapter, ProviderTurnError } from '../provider-turn-types.js';
import { mapOpenAIProviderError } from './openai-responses-errors.js';
import { createOpenAIResponsesMappingState, mapOpenAIResponsesStreamEvent } from './openai-responses-mapper.js';
import {
    bearerTokenForCredential,
    createOpenAIResponsesTransportRequest,
    resolveOpenAICredential,
} from './openai-responses-request.js';
import {
    defaultOpenAIResponsesEndpoint,
    type OpenAIResponsesTransport,
    OpenAIResponsesTransportError,
    type OpenAIResponsesTransportRequest,
} from './openai-responses-transport.js';

export { createNodeOpenAIResponsesTransport } from './openai-responses-http-transport.js';
export type { OpenAIResponsesTransport, OpenAIResponsesTransportRequest };
export { OpenAIResponsesTransportError };

export type OpenAIResponsesProviderOptions = {
    readonly credentialResolver: ProviderCredentialResolver;
    readonly transport: OpenAIResponsesTransport;
    readonly endpoint?: string;
};

export function createOpenAIResponsesProvider(options: OpenAIResponsesProviderOptions): ProviderAdapter {
    return {
        async *streamTurn(request, context) {
            try {
                const credential = await resolveOpenAICredential(options.credentialResolver, request.providerID);
                const bearerToken = bearerTokenForCredential(credential);
                const transportRequest = createOpenAIResponsesTransportRequest({
                    request,
                    bearerToken,
                    signal: context.signal,
                    endpoint: options.endpoint ?? defaultOpenAIResponsesEndpoint,
                });
                const state = createOpenAIResponsesMappingState(request.requestId);

                for await (const rawEvent of options.transport.stream(transportRequest)) {
                    for (const chunk of mapOpenAIResponsesStreamEvent(
                        rawEvent,
                        state,
                        options.credentialResolver.redactForOutput,
                    )) {
                        yield chunk;
                    }
                }
            } catch (error) {
                throw new ProviderTurnError(mapOpenAIProviderError(error, options.credentialResolver));
            }
        },
    };
}
