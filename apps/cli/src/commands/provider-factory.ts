import { modelProviderCatalog } from '@mission-control/config';
import {
    type AnthropicMessagesTransport,
    createAnthropicMessagesProvider,
    createGeminiGenerateContentProvider,
    createNodeAnthropicMessagesTransport,
    createNodeGeminiGenerateContentTransport,
    createNodeOpenAICompatibleTransport,
    createNodeOpenAIResponsesTransport,
    createOpenAICompatibleProvider,
    createOpenAIResponsesProvider,
    type GeminiGenerateContentTransport,
    type OpenAICompatibleTransport,
    type OpenAIResponsesTransport,
    type ProviderAdapter,
} from '@mission-control/core';
import type { ModelProviderSelection, ProviderAdapterFamily } from '@mission-control/protocol';
import { assertUnreachable } from '../assert-unreachable';
import type { ProviderAuthStore } from '../auth-store';
import { findProviderOrThrow } from '../provider-catalog-lookup';
import { createCliProviderCredentialResolver } from '../provider-credential-resolver';
import { createLocalCodingProvider } from './local-coding-provider';

export type CliProviderFactoryTransports = {
    readonly openAIResponses?: OpenAIResponsesTransport;
    readonly anthropicMessages?: AnthropicMessagesTransport;
    readonly geminiGenerateContent?: GeminiGenerateContentTransport;
    readonly openAICompatible?: OpenAICompatibleTransport;
};

export type CliProviderFactoryOptions = {
    readonly transports?: CliProviderFactoryTransports;
};

export function createCliProviderForSelection(
    selection: ModelProviderSelection,
    authStore: ProviderAuthStore,
    options: CliProviderFactoryOptions = {},
): ProviderAdapter {
    const provider = findProviderOrThrow(modelProviderCatalog, selection.providerID);

    const capability = provider.capability;
    if (capability.status !== 'executable' || capability.adapterFamily === undefined) {
        throw new Error(`Provider ${selection.providerID} is ${capability.status} and cannot run coding agent prompts`);
    }

    return createExecutableProvider(capability.adapterFamily, authStore, options);
}

function createExecutableProvider(
    adapterFamily: ProviderAdapterFamily,
    authStore: ProviderAuthStore,
    options: CliProviderFactoryOptions,
): ProviderAdapter {
    switch (adapterFamily) {
        case 'local':
            return createLocalCodingProvider();
        case 'openai-responses':
            return createOpenAIResponsesProvider({
                credentialResolver: createCliProviderCredentialResolver(authStore),
                transport: options.transports?.openAIResponses ?? createNodeOpenAIResponsesTransport(),
            });
        case 'anthropic-messages':
            return createAnthropicMessagesProvider({
                credentialResolver: createCliProviderCredentialResolver(authStore),
                transport: options.transports?.anthropicMessages ?? createNodeAnthropicMessagesTransport(),
            });
        case 'google-gemini':
            return createGeminiGenerateContentProvider({
                credentialResolver: createCliProviderCredentialResolver(authStore),
                transport: options.transports?.geminiGenerateContent ?? createNodeGeminiGenerateContentTransport(),
            });
        case 'openai-compatible':
            return createOpenAICompatibleProvider({
                credentialResolver: createCliProviderCredentialResolver(authStore),
                transport: options.transports?.openAICompatible ?? createNodeOpenAICompatibleTransport(),
            });
        default:
            return assertUnreachable(adapterFamily, 'provider adapter family');
    }
}
