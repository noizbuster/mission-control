import type { AgentMessage, ProviderStreamChunk, ToolDefinition } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createStaticProviderCredentialResolver } from '../credential-resolver.js';
import type { ProviderTurnRequest } from '../provider-turn-types.js';
import {
    createOpenAIResponsesProvider,
    type OpenAIResponsesTransport,
    type OpenAIResponsesTransportRequest,
} from './openai-responses-provider.js';

describe('OpenAI Responses provider adapter', () => {
    it('streams text chunks and disables OpenAI response storage by default', async () => {
        // Given
        const requests: OpenAIResponsesTransportRequest[] = [];
        const provider = createOpenAIResponsesProvider({
            credentialResolver: createStaticProviderCredentialResolver([credential('openai', 'sk-test-secret')]),
            transport: transportFromEvents(requests, [
                { type: 'response.created', response: { id: 'resp_1' }, sequence_number: 0 },
                { type: 'response.output_text.delta', response_id: 'resp_1', sequence_number: 1, delta: 'hel' },
                { type: 'response.output_text.delta', response_id: 'resp_1', sequence_number: 2, delta: 'lo' },
                {
                    type: 'response.completed',
                    sequence_number: 3,
                    response: {
                        id: 'resp_1',
                        status: 'completed',
                        output: [
                            {
                                id: 'msg_1',
                                type: 'message',
                                role: 'assistant',
                                content: [{ type: 'output_text', text: 'hello' }],
                            },
                        ],
                        usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 },
                    },
                },
            ]),
        });

        // When
        const chunks = await collectChunks(
            provider.streamTurn(turnRequest(), { attempt: 1, signal: new AbortController().signal }),
        );

        // Then
        expect(requests[0]).toMatchObject({
            endpoint: 'https://api.openai.com/v1/responses',
            headers: { Authorization: 'Bearer sk-test-secret' },
            body: {
                model: 'gpt-5.5',
                input: [{ role: 'user', content: 'say hello' }],
                stream: true,
                store: false,
                stream_options: { include_obfuscation: false },
            },
        });
        expect(hasOwn(requests[0]?.body, 'reasoning')).toBe(false);
        expect(chunks).toMatchObject([
            { kind: 'response_started', providerResponseId: 'resp_1' },
            { kind: 'text_delta', delta: 'hel' },
            { kind: 'text_delta', delta: 'lo' },
            { kind: 'response_completed', message: { content: 'hello' } },
        ]);
        expect(chunks.at(-1)).toMatchObject({
            usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 },
        });
        expect(JSON.stringify(chunks)).not.toContain('sk-test-secret');
    });

    it('maps streamed function-call arguments to provider-neutral tool chunks without duplicates', async () => {
        // Given
        const provider = createOpenAIResponsesProvider({
            credentialResolver: createStaticProviderCredentialResolver([credential('openai', 'sk-test-secret')]),
            transport: transportFromEvents(
                [],
                [
                    {
                        type: 'response.output_item.added',
                        response_id: 'resp_1',
                        output_index: 0,
                        sequence_number: 1,
                        item: {
                            type: 'function_call',
                            id: 'fc_1',
                            call_id: 'call_1',
                            name: 'repo_read',
                            arguments: '',
                        },
                    },
                    {
                        type: 'response.function_call_arguments.delta',
                        response_id: 'resp_1',
                        item_id: 'fc_1',
                        output_index: 0,
                        sequence_number: 2,
                        delta: '{"path"',
                    },
                    {
                        type: 'response.function_call_arguments.done',
                        response_id: 'resp_1',
                        item_id: 'fc_1',
                        output_index: 0,
                        sequence_number: 3,
                        arguments: '{"path":"README.md"}',
                    },
                    {
                        type: 'response.output_item.done',
                        response_id: 'resp_1',
                        output_index: 0,
                        sequence_number: 4,
                        item: {
                            type: 'function_call',
                            id: 'fc_1',
                            call_id: 'call_1',
                            name: 'repo_read',
                            arguments: '{"path":"README.md"}',
                        },
                    },
                ],
            ),
        });

        // When
        const chunks = await collectChunks(
            provider.streamTurn(turnRequest(), { attempt: 1, signal: new AbortController().signal }),
        );

        // Then
        expect(chunks).toEqual([
            {
                kind: 'tool_call_delta',
                requestId: 'request_openai',
                sequence: 2,
                sourceEventType: 'response.function_call_arguments.delta',
                providerResponseId: 'resp_1',
                toolCallId: 'call_1',
                providerCallId: 'call_1',
                providerItemId: 'fc_1',
                argumentsDelta: '{"path"',
            },
            {
                kind: 'tool_call_completed',
                requestId: 'request_openai',
                sequence: 3,
                sourceEventType: 'response.function_call_arguments.done',
                providerResponseId: 'resp_1',
                toolCall: {
                    toolCallId: 'call_1',
                    toolName: 'repo_read',
                    argumentsJson: '{"path":"README.md"}',
                    providerCallId: 'call_1',
                    providerItemId: 'fc_1',
                },
            },
        ]);
    });

    it('waits for a late Responses call_id before completing a streamed function call', async () => {
        // Given
        const provider = createOpenAIResponsesProvider({
            credentialResolver: createStaticProviderCredentialResolver([credential('openai', 'sk-test-secret')]),
            transport: transportFromEvents(
                [],
                [
                    {
                        type: 'response.function_call_arguments.delta',
                        response_id: 'resp_1',
                        item_id: 'fc_late',
                        output_index: 0,
                        sequence_number: 1,
                        delta: '{"path"',
                    },
                    {
                        type: 'response.function_call_arguments.done',
                        response_id: 'resp_1',
                        item_id: 'fc_late',
                        output_index: 0,
                        sequence_number: 2,
                        arguments: '{"path":"README.md"}',
                    },
                    {
                        type: 'response.output_item.done',
                        response_id: 'resp_1',
                        output_index: 0,
                        sequence_number: 3,
                        item: {
                            type: 'function_call',
                            id: 'fc_late',
                            call_id: 'call_late',
                            name: 'repo_read',
                            arguments: '{"path":"README.md"}',
                        },
                    },
                ],
            ),
        });

        // When
        const chunks = await collectChunks(
            provider.streamTurn(turnRequest(), { attempt: 1, signal: new AbortController().signal }),
        );

        // Then
        expect(chunks).toEqual([
            {
                kind: 'tool_call_delta',
                requestId: 'request_openai',
                sequence: 1,
                sourceEventType: 'response.function_call_arguments.delta',
                providerResponseId: 'resp_1',
                toolCallId: 'tool_call_fc_late',
                providerItemId: 'fc_late',
                argumentsDelta: '{"path"',
            },
            {
                kind: 'tool_call_completed',
                requestId: 'request_openai',
                sequence: 3,
                sourceEventType: 'response.output_item.done',
                providerResponseId: 'resp_1',
                toolCall: {
                    toolCallId: 'call_late',
                    toolName: 'repo_read',
                    argumentsJson: '{"path":"README.md"}',
                    providerCallId: 'call_late',
                    providerItemId: 'fc_late',
                },
            },
        ]);
    });

    it('waits for a Responses completed output item when call_id was not streamed earlier', async () => {
        // Given
        const provider = createOpenAIResponsesProvider({
            credentialResolver: createStaticProviderCredentialResolver([credential('openai', 'sk-test-secret')]),
            transport: transportFromEvents(
                [],
                [
                    {
                        type: 'response.function_call_arguments.done',
                        response_id: 'resp_1',
                        item_id: 'fc_completed',
                        output_index: 0,
                        sequence_number: 1,
                        arguments: '{"path":"README.md"}',
                    },
                    {
                        type: 'response.completed',
                        sequence_number: 2,
                        response: {
                            id: 'resp_1',
                            status: 'completed',
                            output: [
                                {
                                    type: 'function_call',
                                    id: 'fc_completed',
                                    call_id: 'call_completed',
                                    name: 'repo_read',
                                    arguments: '{"path":"README.md"}',
                                },
                            ],
                        },
                    },
                ],
            ),
        });

        // When
        const chunks = await collectChunks(
            provider.streamTurn(turnRequest(), { attempt: 1, signal: new AbortController().signal }),
        );

        // Then
        expect(chunks).toContainEqual({
            kind: 'tool_call_completed',
            requestId: 'request_openai',
            sequence: 2,
            sourceEventType: 'response.completed',
            providerResponseId: 'resp_1',
            toolCall: {
                toolCallId: 'call_completed',
                toolName: 'repo_read',
                argumentsJson: '{"path":"README.md"}',
                providerCallId: 'call_completed',
                providerItemId: 'fc_completed',
            },
        });
    });

    it('does not complete an OpenAI function call before a call_id is known', async () => {
        // Given
        const provider = createOpenAIResponsesProvider({
            credentialResolver: createStaticProviderCredentialResolver([credential('openai', 'sk-test-secret')]),
            transport: transportFromEvents(
                [],
                [
                    {
                        type: 'response.function_call_arguments.done',
                        response_id: 'resp_1',
                        item_id: 'fc_missing_call_id',
                        output_index: 0,
                        sequence_number: 1,
                        arguments: '{"path":"README.md"}',
                    },
                    {
                        type: 'response.completed',
                        sequence_number: 2,
                        response: {
                            id: 'resp_1',
                            status: 'completed',
                            output: [],
                        },
                    },
                ],
            ),
        });

        // When
        const chunks = await collectChunks(
            provider.streamTurn(turnRequest(), { attempt: 1, signal: new AbortController().signal }),
        );

        // Then
        expect(chunks.some((chunk) => chunk.kind === 'tool_call_completed')).toBe(false);
    });

    it('does not complete output_item.done function calls without a call_id', async () => {
        // Given
        const provider = createOpenAIResponsesProvider({
            credentialResolver: createStaticProviderCredentialResolver([credential('openai', 'sk-test-secret')]),
            transport: transportFromEvents(
                [],
                [
                    {
                        type: 'response.output_item.done',
                        response_id: 'resp_1',
                        output_index: 0,
                        sequence_number: 1,
                        item: {
                            type: 'function_call',
                            id: 'fc_no_output_item_call_id',
                            name: 'repo_read',
                            arguments: '{"path":"README.md"}',
                        },
                    },
                ],
            ),
        });

        // When
        const chunks = await collectChunks(
            provider.streamTurn(turnRequest(), { attempt: 1, signal: new AbortController().signal }),
        );

        // Then
        expect(chunks.some((chunk) => chunk.kind === 'tool_call_completed')).toBe(false);
    });

    it('does not complete response.completed output function calls without a call_id', async () => {
        // Given
        const provider = createOpenAIResponsesProvider({
            credentialResolver: createStaticProviderCredentialResolver([credential('openai', 'sk-test-secret')]),
            transport: transportFromEvents(
                [],
                [
                    {
                        type: 'response.completed',
                        sequence_number: 1,
                        response: {
                            id: 'resp_1',
                            status: 'completed',
                            output: [
                                {
                                    type: 'function_call',
                                    id: 'fc_no_completed_call_id',
                                    name: 'repo_read',
                                    arguments: '{"path":"README.md"}',
                                },
                            ],
                        },
                    },
                ],
            ),
        });

        // When
        const chunks = await collectChunks(
            provider.streamTurn(turnRequest(), { attempt: 1, signal: new AbortController().signal }),
        );

        // Then
        expect(chunks.some((chunk) => chunk.kind === 'tool_call_completed')).toBe(false);
    });

    it('sends tool definitions and function call outputs for Responses continuation', async () => {
        // Given
        const requests: OpenAIResponsesTransportRequest[] = [];
        const provider = createOpenAIResponsesProvider({
            credentialResolver: createStaticProviderCredentialResolver([credential('openai', 'sk-test-secret')]),
            transport: transportFromTurnEvents(requests, [
                [
                    {
                        type: 'response.output_item.done',
                        response_id: 'resp_1',
                        output_index: 0,
                        sequence_number: 1,
                        item: {
                            type: 'function_call',
                            id: 'fc_read',
                            call_id: 'call_read',
                            name: 'repo_read',
                            arguments: '{"path":"README.md"}',
                        },
                    },
                    {
                        type: 'response.completed',
                        sequence_number: 2,
                        response: {
                            id: 'resp_1',
                            status: 'completed',
                            output: [],
                        },
                    },
                ],
                [
                    {
                        type: 'response.completed',
                        sequence_number: 1,
                        response: {
                            id: 'resp_2',
                            status: 'completed',
                            output: [
                                {
                                    id: 'msg_2',
                                    type: 'message',
                                    role: 'assistant',
                                    content: [{ type: 'output_text', text: 'README says hello' }],
                                },
                            ],
                        },
                    },
                ],
            ]),
        });

        // When
        const firstChunks = await collectChunks(
            provider.streamTurn(turnRequest({ tools: [readToolDefinition()] }), {
                attempt: 1,
                signal: new AbortController().signal,
            }),
        );
        const continuationChunks = await collectChunks(
            provider.streamTurn(
                turnRequest({
                    requestId: 'request_openai_continuation',
                    messages: [
                        { role: 'user', content: 'read README' },
                        {
                            role: 'assistant',
                            content: 'need README',
                            providerToolCalls: [
                                {
                                    providerID: 'openai',
                                    providerItemId: 'fc_read',
                                    providerCallId: 'call_read',
                                    toolCallId: 'call_read',
                                    toolName: 'repo_read',
                                    argumentsJson: '{"path":"README.md"}',
                                },
                            ],
                        },
                        { role: 'tool', toolCallId: 'call_read', status: 'completed', output: 'README contents' },
                    ],
                    tools: [readToolDefinition()],
                }),
                { attempt: 1, signal: new AbortController().signal },
            ),
        );

        // Then
        expect(requests).toHaveLength(2);
        expect(requests[0]?.body).toMatchObject({
            store: false,
            tools: [
                {
                    type: 'function',
                    name: 'repo_read',
                    description: 'Read a file',
                    parameters: {
                        type: 'object',
                        properties: {
                            path: { type: 'string' },
                        },
                        required: ['path'],
                    },
                },
            ],
        });
        expect(firstChunks).toContainEqual(
            expect.objectContaining({
                kind: 'tool_call_completed',
                toolCall: expect.objectContaining({
                    toolCallId: 'call_read',
                    providerCallId: 'call_read',
                    providerItemId: 'fc_read',
                }),
            }),
        );
        expect(requests[1]?.body).toMatchObject({
            store: false,
            input: [
                { role: 'user', content: 'read README' },
                { role: 'assistant', content: 'need README' },
                {
                    type: 'function_call',
                    id: 'fc_read',
                    call_id: 'call_read',
                    name: 'repo_read',
                    arguments: '{"path":"README.md"}',
                },
                {
                    type: 'function_call_output',
                    call_id: 'call_read',
                    output: 'README contents',
                },
            ],
        });
        expect(continuationChunks).toContainEqual(
            expect.objectContaining({
                kind: 'response_completed',
                message: expect.objectContaining({ content: 'README says hello' }),
            }),
        );
        expect(JSON.stringify(requests.map((request) => request.body))).not.toContain('sk-test-secret');
    });
});

function credential(providerID: string, apiKey: string) {
    return {
        providerID,
        type: 'apiKey' as const,
        apiKey,
        createdAt: '2026-06-09T10:00:00.000Z',
        updatedAt: '2026-06-09T10:00:00.000Z',
    };
}

function turnRequest(
    input: {
        readonly requestId?: string;
        readonly messages?: readonly AgentMessage[];
        readonly tools?: readonly ToolDefinition[];
    } = {},
): ProviderTurnRequest {
    return {
        requestId: input.requestId ?? 'request_openai',
        sessionId: 'session_openai',
        turnId: 'turn_openai',
        providerID: 'openai',
        modelID: 'gpt-5.5',
        messages: input.messages ?? [{ role: 'user', content: 'say hello' }],
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
    };
}

function readToolDefinition(): ToolDefinition {
    return {
        name: 'repo_read',
        description: 'Read a file',
        parametersJsonSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
            },
            required: ['path'],
        },
    };
}

function transportFromEvents(
    requests: OpenAIResponsesTransportRequest[],
    events: readonly unknown[],
): OpenAIResponsesTransport {
    return {
        async *stream(request) {
            requests.push(request);
            for (const event of events) {
                yield event;
            }
        },
    };
}

function transportFromTurnEvents(
    requests: OpenAIResponsesTransportRequest[],
    turns: readonly (readonly unknown[])[],
): OpenAIResponsesTransport {
    return {
        async *stream(request) {
            requests.push(request);
            const events = turns[requests.length - 1] ?? [];
            for (const event of events) {
                yield event;
            }
        },
    };
}

async function collectChunks(stream: AsyncIterable<ProviderStreamChunk>): Promise<readonly ProviderStreamChunk[]> {
    const chunks: ProviderStreamChunk[] = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return chunks;
}

function hasOwn(value: object | undefined, key: string): boolean {
    return value !== undefined && Object.hasOwn(value, key);
}
