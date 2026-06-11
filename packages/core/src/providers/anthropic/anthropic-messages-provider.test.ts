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
