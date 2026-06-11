import type { ProviderCredentialResolver } from '../credential-resolver.js';
import { type ProviderAdapter, ProviderTurnError } from '../provider-turn-types.js';
import { mapAnthropicProviderError } from './anthropic-messages-errors.js';
import { createAnthropicMessagesMappingState, mapAnthropicMessagesStreamEvent } from './anthropic-messages-mapper.js';
import {
    apiKeyForAnthropicCredential,
    createAnthropicMessagesTransportRequest,
    resolveAnthropicCredential,
} from './anthropic-messages-request.js';
import {
    type AnthropicMessagesTransport,
    AnthropicMessagesTransportError,
    type AnthropicMessagesTransportRequest,
    defaultAnthropicMessagesEndpoint,
} from './anthropic-messages-transport.js';

export { createNodeAnthropicMessagesTransport } from './anthropic-messages-http-transport.js';
export type { AnthropicMessagesTransport, AnthropicMessagesTransportRequest };
export { AnthropicMessagesTransportError };

export type AnthropicMessagesProviderOptions = {
    readonly credentialResolver: ProviderCredentialResolver;
    readonly transport: AnthropicMessagesTransport;
    readonly endpoint?: string;
};

export function createAnthropicMessagesProvider(options: AnthropicMessagesProviderOptions): ProviderAdapter {
    return {
        async *streamTurn(request, context) {
            try {
                const credential = await resolveAnthropicCredential(options.credentialResolver, request.providerID);
                const apiKey = apiKeyForAnthropicCredential(credential);
                const transportRequest = createAnthropicMessagesTransportRequest({
                    request,
                    apiKey,
                    signal: context.signal,
                    endpoint: options.endpoint ?? defaultAnthropicMessagesEndpoint,
                });
                const state = createAnthropicMessagesMappingState(request.requestId);

                for await (const rawEvent of options.transport.stream(transportRequest)) {
                    for (const chunk of mapAnthropicMessagesStreamEvent(
                        rawEvent,
                        state,
                        options.credentialResolver.redactForOutput,
                    )) {
                        yield chunk;
                    }
                }
            } catch (error) {
                throw new ProviderTurnError(mapAnthropicProviderError(error, options.credentialResolver));
            }
        },
    };
}
