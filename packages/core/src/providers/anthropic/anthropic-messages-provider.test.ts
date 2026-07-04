import { describe, expect, it } from 'vitest';
import { createStaticProviderCredentialResolver } from '../credential-resolver.js';
import {
    AnthropicMessagesTransportError,
    type AnthropicMessagesTransportRequest,
    createAnthropicMessagesProvider,
} from './anthropic-messages-provider.js';
import {
    anthropicCredential,
    anthropicTurnRequest,
    captureError,
    collectChunks,
    readToolDefinition,
    throwingStream,
    transportFromEvents,
} from './anthropic-messages-test-support.js';

describe('Anthropic Messages provider adapter', () => {
    it('streams text chunks and sends authenticated Messages requests with tools', async () => {
        // Given
        const requests: AnthropicMessagesTransportRequest[] = [];
        const provider = createAnthropicMessagesProvider({
            credentialResolver: createStaticProviderCredentialResolver([
                anthropicCredential('anthropic', 'sk-ant-test-secret'),
            ]),
            transport: transportFromEvents(requests, [
                {
                    type: 'message_start',
                    message: { id: 'msg_1', type: 'message', role: 'assistant', content: [] },
                },
                {
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'text', text: '' },
                },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hel' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
                { type: 'content_block_stop', index: 0 },
                {
                    type: 'message_delta',
                    delta: { stop_reason: 'end_turn' },
                    usage: { output_tokens: 2 },
                },
                { type: 'message_stop' },
            ]),
        });

        // When
        const chunks = await collectChunks(
            provider.streamTurn(anthropicTurnRequest({ tools: [readToolDefinition()] }), {
                attempt: 1,
                signal: new AbortController().signal,
            }),
        );

        // Then
        expect(requests[0]).toMatchObject({
            endpoint: 'https://api.anthropic.com/v1/messages',
            headers: {
                'x-api-key': 'sk-ant-test-secret',
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
            },
            body: {
                model: 'claude-sonnet-4-6',
                max_tokens: 4096,
                stream: true,
                messages: [{ role: 'user', content: 'say hello' }],
                tools: [
                    {
                        name: 'repo_read',
                        description: 'Read a file',
                        input_schema: {
                            type: 'object',
                            properties: { path: { type: 'string' } },
                            required: ['path'],
                        },
                    },
                ],
            },
        });
        expect(chunks).toMatchObject([
            { kind: 'response_started', providerResponseId: 'msg_1' },
            { kind: 'text_delta', delta: 'hel' },
            { kind: 'text_delta', delta: 'lo' },
            { kind: 'response_completed', message: { content: 'hello' } },
        ]);
        expect(chunks.at(-1)).toMatchObject({
            usage: { inputTokens: 0, outputTokens: 2, totalTokens: 2 },
        });
        expect(JSON.stringify(requests.map((request) => request.body))).not.toContain('sk-ant-test-secret');
        expect(JSON.stringify(chunks)).not.toContain('sk-ant-test-secret');
    });

    it('streams reasoning chunks for thinking content blocks and populates message.reasoning', async () => {
        // Given
        const provider = createAnthropicMessagesProvider({
            credentialResolver: createStaticProviderCredentialResolver([
                anthropicCredential('anthropic', 'sk-ant-test-secret'),
            ]),
            transport: transportFromEvents([], [
                {
                    type: 'message_start',
                    message: { id: 'msg_thinking', type: 'message', role: 'assistant', content: [] },
                },
                {
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'thinking', thinking: '' },
                },
                { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reason.' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'cryptsig' } },
                { type: 'content_block_stop', index: 0 },
                {
                    type: 'content_block_start',
                    index: 1,
                    content_block: { type: 'text', text: '' },
                },
                { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } },
                { type: 'content_block_stop', index: 1 },
                {
                    type: 'message_delta',
                    delta: { stop_reason: 'end_turn' },
                    usage: { output_tokens: 5 },
                },
                { type: 'message_stop' },
            ]),
        });

        // When
        const chunks = await collectChunks(
            provider.streamTurn(anthropicTurnRequest(), { attempt: 1, signal: new AbortController().signal }),
        );

        // Then
        const reasoningDeltas = chunks.filter((c) => c.kind === 'reasoning_delta');
        const reasoningCompleted = chunks.filter((c) => c.kind === 'reasoning_completed');
        const textDeltas = chunks.filter((c) => c.kind === 'text_delta');
        const completed = chunks.find((c) => c.kind === 'response_completed');

        expect(reasoningDeltas).toMatchObject([
            { kind: 'reasoning_delta', delta: 'Let me ' },
            { kind: 'reasoning_delta', delta: 'reason.' },
        ]);
        expect(reasoningCompleted).toMatchObject([{ kind: 'reasoning_completed', text: 'Let me reason.' }]);
        expect(textDeltas).toMatchObject([{ kind: 'text_delta', delta: 'Answer' }]);
        expect(completed).toMatchObject({
            kind: 'response_completed',
            message: { content: 'Answer', reasoning: 'Let me reason.' },
        });
        // signature_delta must NOT produce any chunk
        expect(JSON.stringify(chunks)).not.toContain('cryptsig');
    });

    it('emits zero reasoning chunks for a turn without thinking blocks', async () => {
        // Given — stale_state probe: a second turn after a reasoning turn must reset state
        const provider = createAnthropicMessagesProvider({
            credentialResolver: createStaticProviderCredentialResolver([
                anthropicCredential('anthropic', 'sk-ant-test-secret'),
            ]),
            transport: transportFromEvents([], [
                {
                    type: 'message_start',
                    message: { id: 'msg_plain', type: 'message', role: 'assistant', content: [] },
                },
                {
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'text', text: '' },
                },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
                { type: 'content_block_stop', index: 0 },
                {
                    type: 'message_delta',
                    delta: { stop_reason: 'end_turn' },
                    usage: { output_tokens: 1 },
                },
                { type: 'message_stop' },
            ]),
        });

        // When
        const chunks = await collectChunks(
            provider.streamTurn(anthropicTurnRequest(), { attempt: 1, signal: new AbortController().signal }),
        );

        // Then — no reasoning chunks, no reasoning field on message
        expect(chunks.filter((c) => c.kind === 'reasoning_delta')).toHaveLength(0);
        expect(chunks.filter((c) => c.kind === 'reasoning_completed')).toHaveLength(0);
        const completed = chunks.find((c) => c.kind === 'response_completed');
        expect(completed).toMatchObject({ message: { content: 'hi' } });
        expect(completed && 'reasoning' in (completed as { message: Record<string, unknown> }).message).toBe(false);
    });

    it('maps auth failures without leaking the Anthropic API key', async () => {
        // Given
        const provider = createAnthropicMessagesProvider({
            credentialResolver: createStaticProviderCredentialResolver([
                anthropicCredential('anthropic', 'sk-ant-test-secret'),
            ]),
            transport: {
                stream() {
                    return throwingStream(
                        new AnthropicMessagesTransportError({
                            status: 401,
                            message: 'invalid key sk-ant-test-secret',
                        }),
                    );
                },
            },
        });

        // When
        const error = await captureError(
            collectChunks(
                provider.streamTurn(anthropicTurnRequest(), {
                    attempt: 1,
                    signal: new AbortController().signal,
                }),
            ),
        );

        // Then
        expect(error).toMatchObject({
            error: {
                code: 'provider_auth_failed',
                message: 'invalid key [REDACTED_CREDENTIAL]',
                retryable: false,
            },
        });
        expect(JSON.stringify(error)).not.toContain('sk-ant-test-secret');
    });
});
