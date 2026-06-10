import type { ProviderStreamChunk } from '@mission-control/protocol';
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
                toolCallId: 'tool_call_fc_1',
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
                    toolCallId: 'tool_call_fc_1',
                    toolName: 'repo_read',
                    argumentsJson: '{"path":"README.md"}',
                    providerCallId: 'call_1',
                    providerItemId: 'fc_1',
                },
            },
        ]);
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

function turnRequest(): ProviderTurnRequest {
    return {
        requestId: 'request_openai',
        sessionId: 'session_openai',
        turnId: 'turn_openai',
        providerID: 'openai',
        modelID: 'gpt-5.5',
        messages: [{ role: 'user', content: 'say hello' }],
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

async function collectChunks(stream: AsyncIterable<ProviderStreamChunk>): Promise<readonly ProviderStreamChunk[]> {
    const chunks: ProviderStreamChunk[] = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return chunks;
}
