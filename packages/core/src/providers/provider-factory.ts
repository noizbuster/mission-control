import { modelProviderCatalog } from '@mission-control/config';
import type { ModelProviderSelection, ProviderAdapterFamily } from '@mission-control/protocol';
import {
    type AnthropicMessagesTransport,
    createAnthropicMessagesProvider,
    createNodeAnthropicMessagesTransport,
} from './anthropic/anthropic-messages-provider.js';
import { type ProviderCredentialResolver } from './credential-resolver.js';
import {
    createGeminiGenerateContentProvider,
    createNodeGeminiGenerateContentTransport,
    type GeminiGenerateContentTransport,
} from './google/gemini-generate-content-provider.js';
import { createLocalCodingProvider } from './local-coding-provider.js';
import {
    createNodeOpenAIResponsesTransport,
    createOpenAIResponsesProvider,
    type OpenAIResponsesTransport,
} from './openai/openai-responses-provider.js';
import {
    createNodeOpenAICompatibleTransport,
    createOpenAICompatibleProvider,
    type OpenAICompatibleTransport,
} from './openai-compatible/openai-compatible-provider.js';
import type { ProviderAdapter } from './provider-turn-types.js';

export type ProviderFactoryTransports = {
    readonly openAIResponses?: OpenAIResponsesTransport;
    readonly anthropicMessages?: AnthropicMessagesTransport;
    readonly geminiGenerateContent?: GeminiGenerateContentTransport;
    readonly openAICompatible?: OpenAICompatibleTransport;
};

export type ProviderFactoryOptions = {
    readonly transports?: ProviderFactoryTransports;
};

export function createProviderForSelection(
    selection: ModelProviderSelection,
    credentialResolver: ProviderCredentialResolver,
    options: ProviderFactoryOptions = {},
): ProviderAdapter {
    const provider = modelProviderCatalog.find((entry) => entry.id === selection.providerID);
    if (provider === undefined) {
        throw new Error(`Unknown provider: ${selection.providerID}`);
    }

    const capability = provider.capability;
    if (capability.status !== 'executable' || capability.adapterFamily === undefined) {
        throw new Error(`Provider ${selection.providerID} is ${capability.status} and cannot run coding agent prompts`);
    }

    return createExecutableProvider(capability.adapterFamily, credentialResolver, options);
}

export function createProviderRouter(
    credentialResolver: ProviderCredentialResolver,
    options: ProviderFactoryOptions = {},
): ProviderAdapter {
    return {
        streamTurn(request, context) {
            return createProviderForSelection(
                {
                    providerID: request.providerID,
                    modelID: request.modelID,
                    ...(request.variantID !== undefined ? { variantID: request.variantID } : {}),
                },
                credentialResolver,
                options,
            ).streamTurn(request, context);
        },
    };
}

function createExecutableProvider(
    adapterFamily: ProviderAdapterFamily,
    credentialResolver: ProviderCredentialResolver,
    options: ProviderFactoryOptions,
): ProviderAdapter {
    switch (adapterFamily) {
        case 'local':
            return createLocalCodingProvider();
        case 'openai-responses':
            return createOpenAIResponsesProvider({
                credentialResolver,
                transport: options.transports?.openAIResponses ?? createNodeOpenAIResponsesTransport(),
            });
        case 'anthropic-messages':
            return createAnthropicMessagesProvider({
                credentialResolver,
                transport: options.transports?.anthropicMessages ?? createNodeAnthropicMessagesTransport(),
            });
        case 'google-gemini':
            return createGeminiGenerateContentProvider({
                credentialResolver,
                transport: options.transports?.geminiGenerateContent ?? createNodeGeminiGenerateContentTransport(),
            });
        case 'openai-compatible':
            return createOpenAICompatibleProvider({
                credentialResolver,
                transport: options.transports?.openAICompatible ?? createNodeOpenAICompatibleTransport(),
            });
        default:
            return assertNever(adapterFamily);
    }
}

function assertNever(value: never): never {
    throw new Error(`Unexpected provider adapter family: ${String(value)}`);
}
