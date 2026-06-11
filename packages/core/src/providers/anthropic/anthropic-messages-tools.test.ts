import { describe, expect, it } from 'vitest';
import { createStaticProviderCredentialResolver } from '../credential-resolver.js';
import {
    type AnthropicMessagesTransportRequest,
    createAnthropicMessagesProvider,
} from './anthropic-messages-provider.js';
import {
    anthropicCredential,
    anthropicTurnRequest,
    captureError,
    collectChunks,
    readToolDefinition,
    transportFromEvents,
    transportFromTurnEvents,
} from './anthropic-messages-test-support.js';

describe('Anthropic Messages tool use', () => {
    it('maps Anthropic tool_use blocks to provider-neutral tool calls and transcript metadata', async () => {
        // Given
        const provider = createAnthropicMessagesProvider({
            credentialResolver: createStaticProviderCredentialResolver([
                anthropicCredential('anthropic', 'sk-ant-test-secret'),
            ]),
            transport: transportFromEvents(
                [],
                [
                    {
                        type: 'message_start',
                        message: { id: 'msg_tools', type: 'message', role: 'assistant', content: [] },
                    },
                    {
                        type: 'content_block_start',
                        index: 0,
                        content_block: { type: 'text', text: '' },
                    },
                    {
                        type: 'content_block_delta',
                        index: 0,
                        delta: { type: 'text_delta', text: 'need README' },
                    },
                    { type: 'content_block_stop', index: 0 },
                    {
                        type: 'content_block_start',
                        index: 1,
                        content_block: {
                            type: 'tool_use',
                            id: 'toolu_read',
                            name: 'repo_read',
                            input: {},
                        },
                    },
                    {
                        type: 'content_block_delta',
                        index: 1,
                        delta: { type: 'input_json_delta', partial_json: '{"path":"README.md"}' },
                    },
                    { type: 'content_block_stop', index: 1 },
                    {
                        type: 'message_delta',
                        delta: { stop_reason: 'tool_use' },
                        usage: { input_tokens: 7, output_tokens: 3 },
                    },
                    { type: 'message_stop' },
                ],
            ),
        });

        // When
        const chunks = await collectChunks(
            provider.streamTurn(anthropicTurnRequest(), { attempt: 1, signal: new AbortController().signal }),
        );

        // Then
        expect(chunks).toContainEqual({
            kind: 'tool_call_delta',
            requestId: 'request_anthropic',
            sequence: 5,
            sourceEventType: 'content_block_delta',
            providerResponseId: 'msg_tools',
            toolCallId: 'toolu_read',
            providerCallId: 'toolu_read',
            providerItemId: '1',
            argumentsDelta: '{"path":"README.md"}',
        });
        expect(chunks).toContainEqual({
            kind: 'tool_call_completed',
            requestId: 'request_anthropic',
            sequence: 6,
            sourceEventType: 'content_block_stop',
            providerResponseId: 'msg_tools',
            toolCall: {
                toolCallId: 'toolu_read',
                toolName: 'repo_read',
                argumentsJson: '{"path":"README.md"}',
                providerCallId: 'toolu_read',
                providerItemId: '1',
            },
        });
        expect(chunks).toContainEqual(
            expect.objectContaining({
                kind: 'response_completed',
                finishReason: 'tool_calls',
                message: expect.objectContaining({
                    content: 'need README',
                    toolCallIds: ['toolu_read'],
                    providerToolCalls: [
                        {
                            providerID: 'anthropic',
                            toolCallId: 'toolu_read',
                            providerCallId: 'toolu_read',
                            providerItemId: '1',
                            toolName: 'repo_read',
                            argumentsJson: '{"path":"README.md"}',
                        },
                    ],
                }),
            }),
        );
    });

    it('sends assistant tool_use and user tool_result blocks for continuation', async () => {
        // Given
        const requests: AnthropicMessagesTransportRequest[] = [];
        const provider = createAnthropicMessagesProvider({
            credentialResolver: createStaticProviderCredentialResolver([
                anthropicCredential('anthropic', 'sk-ant-test-secret'),
            ]),
            transport: transportFromTurnEvents(requests, [
                [{ type: 'message_stop' }],
                [
                    {
                        type: 'message_start',
                        message: { id: 'msg_final', type: 'message', role: 'assistant', content: [] },
                    },
                    {
                        type: 'content_block_start',
                        index: 0,
                        content_block: { type: 'text', text: '' },
                    },
                    {
                        type: 'content_block_delta',
                        index: 0,
                        delta: { type: 'text_delta', text: 'README says hello' },
                    },
                    { type: 'content_block_stop', index: 0 },
                    {
                        type: 'message_delta',
                        delta: { stop_reason: 'end_turn' },
                        usage: { input_tokens: 8, output_tokens: 4 },
                    },
                    { type: 'message_stop' },
                ],
            ]),
        });

        // When
        await collectChunks(
            provider.streamTurn(anthropicTurnRequest({ tools: [readToolDefinition()] }), {
                attempt: 1,
                signal: new AbortController().signal,
            }),
        );
        const continuationChunks = await collectChunks(
            provider.streamTurn(
                anthropicTurnRequest({
                    requestId: 'request_anthropic_continuation',
                    messages: [
                        { role: 'user', content: 'read README' },
                        {
                            role: 'assistant',
                            content: 'need README',
                            providerToolCalls: [
                                {
                                    providerID: 'anthropic',
                                    providerItemId: '1',
                                    providerCallId: 'toolu_read',
                                    toolCallId: 'toolu_read',
                                    toolName: 'repo_read',
                                    argumentsJson: '{"path":"README.md"}',
                                },
                            ],
                        },
                        { role: 'tool', toolCallId: 'toolu_read', status: 'completed', output: 'README contents' },
                    ],
                    tools: [readToolDefinition()],
                }),
                { attempt: 1, signal: new AbortController().signal },
            ),
        );

        // Then
        expect(requests[1]?.body.messages).toEqual([
            { role: 'user', content: 'read README' },
            {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'need README' },
                    {
                        type: 'tool_use',
                        id: 'toolu_read',
                        name: 'repo_read',
                        input: { path: 'README.md' },
                    },
                ],
            },
            {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'README contents' }],
            },
        ]);
        expect(continuationChunks).toContainEqual(
            expect.objectContaining({
                kind: 'response_completed',
                message: expect.objectContaining({ content: 'README says hello' }),
            }),
        );
    });

    it('fails malformed Anthropic tool_use blocks before emitting a completed tool call', async () => {
        // Given
        const provider = createAnthropicMessagesProvider({
            credentialResolver: createStaticProviderCredentialResolver([
                anthropicCredential('anthropic', 'sk-ant-test-secret'),
            ]),
            transport: transportFromEvents(
                [],
                [
                    {
                        type: 'message_start',
                        message: { id: 'msg_malformed', type: 'message', role: 'assistant', content: [] },
                    },
                    {
                        type: 'content_block_start',
                        index: 0,
                        content_block: { type: 'tool_use', name: 'repo_read', input: {} },
                    },
                    { type: 'message_stop' },
                ],
            ),
        });

        // When
        const error = await captureError(
            collectChunks(
                provider.streamTurn(anthropicTurnRequest(), { attempt: 1, signal: new AbortController().signal }),
            ),
        );

        // Then
        expect(error).toMatchObject({
            error: {
                code: 'schema_invalid',
                retryable: false,
            },
        });
    });
});
