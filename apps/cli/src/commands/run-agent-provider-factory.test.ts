import type {
    AnthropicMessagesTransport,
    AnthropicMessagesTransportRequest,
    GeminiGenerateContentTransport,
    GeminiGenerateContentTransportRequest,
    OpenAICompatibleTransport,
    OpenAICompatibleTransportRequest,
    OpenAIResponsesTransport,
    OpenAIResponsesTransportRequest,
    ProviderAdapter,
    ProviderTurnRequest,
} from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';
import type { ProviderAuthStore } from '../auth-store.js';
import { createCliProviderForSelection, runAgent } from './run-agent.js';
import {
    createAuthStoreWithSummaries,
    createCredentialSummary,
    createFieldsCredential,
} from './run-agent-chat-test-support.js';

describe('runAgent provider factory', () => {
    it('creates declared executable adapter families for CLI selections', async () => {
        // Given
        const requests = createCapturedRequests();
        const authStore = createProviderAuthStore();
        const factoryOptions = { transports: createCapturedTransports(requests) };

        // When
        await drainProvider(
            createCliProviderForSelection({ providerID: 'openai', modelID: 'gpt-5' }, authStore, factoryOptions),
            { providerID: 'openai', modelID: 'gpt-5' },
        );
        await drainProvider(
            createCliProviderForSelection(
                { providerID: 'anthropic', modelID: 'claude-3-5-haiku-20241022' },
                authStore,
                factoryOptions,
            ),
            { providerID: 'anthropic', modelID: 'claude-3-5-haiku-20241022' },
        );
        await drainProvider(
            createCliProviderForSelection(
                { providerID: 'google', modelID: 'gemini-2.0-flash' },
                authStore,
                factoryOptions,
            ),
            { providerID: 'google', modelID: 'gemini-2.0-flash' },
        );
        await drainProvider(
            createCliProviderForSelection({ providerID: 'groq', modelID: 'allam-2-7b' }, authStore, factoryOptions),
            { providerID: 'groq', modelID: 'allam-2-7b' },
        );

        // Then
        expect(requests.openAIResponses[0]).toMatchObject({
            endpoint: 'https://api.openai.com/v1/responses',
            headers: { Authorization: 'Bearer openai_secret' },
            body: { model: 'gpt-5', stream: true, store: false },
        });
        expect(requests.anthropicMessages[0]).toMatchObject({
            endpoint: 'https://api.anthropic.com/v1/messages',
            headers: { 'x-api-key': 'anthropic_secret' },
            body: { model: 'claude-3-5-haiku-20241022', stream: true },
        });
        expect(requests.geminiGenerateContent[0]).toMatchObject({
            endpoint:
                'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse',
            headers: { 'x-goog-api-key': 'google_secret' },
        });
        expect(requests.openAICompatible[0]).toMatchObject({
            endpoint: 'https://api.groq.com/openai/v1/chat/completions',
            headers: { Authorization: 'Bearer groq_secret' },
            body: { model: 'allam-2-7b', stream: true },
        });
    });

    it('rejects authenticated non-executable providers instead of falling back to local output', async () => {
        // Given
        const authStore = createAuthStoreWithSummaries([createCredentialSummary('cohere')], {
            cohere: createFieldsCredential('cohere', 'cohere_secret'),
        });

        // When
        const message = await rejectedMessage(() =>
            runAgent(
                parseArgs(['run', 'should not use local output', '--json', '--model', 'cohere/c4ai-aya-expanse-32b']),
                {
                    authStore,
                },
            ),
        );

        // Then
        expect(message).toContain('Provider cohere is model-discovery-only and cannot run coding agent prompts');
        expect(message).not.toContain('received prompt: should not use local output');
    });
});

type CapturedTransportRequests = {
    readonly openAIResponses: OpenAIResponsesTransportRequest[];
    readonly anthropicMessages: AnthropicMessagesTransportRequest[];
    readonly geminiGenerateContent: GeminiGenerateContentTransportRequest[];
    readonly openAICompatible: OpenAICompatibleTransportRequest[];
};

function createCapturedRequests(): CapturedTransportRequests {
    return {
        openAIResponses: [],
        anthropicMessages: [],
        geminiGenerateContent: [],
        openAICompatible: [],
    };
}

function createProviderAuthStore(): ProviderAuthStore {
    return createAuthStoreWithSummaries([], {
        openai: createFieldsCredential('openai', 'openai_secret'),
        anthropic: createFieldsCredential('anthropic', 'anthropic_secret'),
        google: createFieldsCredential('google', 'google_secret'),
        groq: createFieldsCredential('groq', 'groq_secret'),
    });
}

function createCapturedTransports(requests: CapturedTransportRequests) {
    return {
        openAIResponses: captureOpenAIResponses(requests.openAIResponses),
        anthropicMessages: captureAnthropicMessages(requests.anthropicMessages),
        geminiGenerateContent: captureGeminiGenerateContent(requests.geminiGenerateContent),
        openAICompatible: captureOpenAICompatible(requests.openAICompatible),
    };
}

function captureOpenAIResponses(requests: OpenAIResponsesTransportRequest[]): OpenAIResponsesTransport {
    return {
        stream(request) {
            requests.push(request);
            return emptyAsyncIterable();
        },
    };
}

function captureAnthropicMessages(requests: AnthropicMessagesTransportRequest[]): AnthropicMessagesTransport {
    return {
        stream(request) {
            requests.push(request);
            return emptyAsyncIterable();
        },
    };
}

function captureGeminiGenerateContent(
    requests: GeminiGenerateContentTransportRequest[],
): GeminiGenerateContentTransport {
    return {
        stream(request) {
            requests.push(request);
            return emptyAsyncIterable();
        },
    };
}

function captureOpenAICompatible(requests: OpenAICompatibleTransportRequest[]): OpenAICompatibleTransport {
    return {
        stream(request) {
            requests.push(request);
            return emptyAsyncIterable();
        },
    };
}

function emptyAsyncIterable(): AsyncIterable<unknown> {
    return {
        [Symbol.asyncIterator]() {
            return {
                next: async () => ({ done: true, value: undefined }),
            };
        },
    };
}

async function drainProvider(provider: ProviderAdapter, selection: ModelProviderSelection): Promise<void> {
    for await (const chunk of provider.streamTurn(providerRequest(selection), {
        attempt: 1,
        signal: new AbortController().signal,
    })) {
        void chunk;
    }
}

function providerRequest(selection: ModelProviderSelection): ProviderTurnRequest {
    return {
        requestId: `request_${selection.providerID}`,
        sessionId: `session_${selection.providerID}`,
        turnId: `turn_${selection.providerID}`,
        providerID: selection.providerID,
        modelID: selection.modelID,
        ...(selection.variantID !== undefined ? { variantID: selection.variantID } : {}),
        messages: [{ role: 'user', content: 'hello from provider factory test' }],
    };
}

async function rejectedMessage(run: () => Promise<string>): Promise<string> {
    try {
        await run();
    } catch (error: unknown) {
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }
    throw new Error('expected runAgent to reject');
}
