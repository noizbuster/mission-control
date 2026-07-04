import { describe, expect, it } from 'vitest';
import {
    ProtocolErrorSchema,
    ProviderMessageSchema,
    ProviderRequestSchema,
    ProviderStreamChunkSchema,
    RedactionMetadataSchema,
    ToolCallSchema,
    ToolCallSettlementSchema,
    ToolResultSchema,
} from './provider-events.js';

describe('provider event protocol schemas', () => {
    it('parses provider requests without accepting raw credential payloads', () => {
        const request = ProviderRequestSchema.parse({
            requestId: 'provider_request_1',
            sessionId: 'session_1',
            turnId: 'turn_1',
            providerID: 'openai',
            modelID: 'gpt-5',
            messages: [
                {
                    role: 'user',
                    content: 'Summarize this repository.',
                },
                {
                    role: 'tool',
                    toolCallId: 'tool_call_1',
                    status: 'completed',
                    output: 'README contents',
                },
            ],
            tools: [
                {
                    name: 'repo.read',
                    description: 'Read a repository file.',
                    parametersJsonSchema: {
                        type: 'object',
                        properties: {
                            path: {
                                type: 'string',
                            },
                        },
                    },
                },
            ],
        });
        const withRawCredential = ProviderRequestSchema.safeParse({
            requestId: 'provider_request_1',
            sessionId: 'session_1',
            turnId: 'turn_1',
            providerID: 'openai',
            modelID: 'gpt-5',
            messages: [],
            credential: {
                apiKey: 'credential_sentinel_value',
            },
        });

        expect(request.messages[1]).toMatchObject({ role: 'tool', toolCallId: 'tool_call_1' });
        expect(request.tools?.[0]?.name).toBe('repo.read');
        expect(withRawCredential.success).toBe(false);
    });

    it('parses provider stream chunks, completed messages, and typed errors', () => {
        const textDelta = ProviderStreamChunkSchema.parse({
            kind: 'text_delta',
            requestId: 'provider_request_1',
            sequence: 1,
            sourceEventType: 'response.output_text.delta',
            providerResponseId: 'resp_1',
            delta: 'hello',
        });
        const completed = ProviderStreamChunkSchema.parse({
            kind: 'response_completed',
            requestId: 'provider_request_1',
            sequence: 2,
            providerResponseId: 'resp_1',
            message: {
                messageId: 'message_1',
                role: 'assistant',
                content: 'hello',
            },
            finishReason: 'stop',
            usage: {
                inputTokens: 10,
                outputTokens: 2,
                totalTokens: 12,
            },
        });
        const failed = ProviderStreamChunkSchema.parse({
            kind: 'response_failed',
            requestId: 'provider_request_1',
            sequence: 3,
            error: {
                code: 'provider_timeout',
                message: 'provider timed out',
                retryable: true,
            },
        });

        expect(textDelta).toMatchObject({
            kind: 'text_delta',
            delta: 'hello',
        });
        expect(completed).toMatchObject({
            kind: 'response_completed',
            message: {
                content: 'hello',
            },
        });
        expect(failed).toMatchObject({
            kind: 'response_failed',
            error: {
                code: 'provider_timeout',
            },
        });
    });

    it('parses reasoning_delta and reasoning_completed stream chunks mirroring the text_delta envelope', () => {
        const reasoningDelta = ProviderStreamChunkSchema.parse({
            kind: 'reasoning_delta',
            requestId: 'provider_request_1',
            sequence: 1,
            sourceEventType: 'response.reasoning.delta',
            providerResponseId: 'resp_1',
            delta: 'thinking...',
        });
        const reasoningDeltaWithRedactions = ProviderStreamChunkSchema.parse({
            kind: 'reasoning_delta',
            requestId: 'provider_request_1',
            sequence: 2,
            delta: 'redacted thought',
            redactions: [
                {
                    classification: 'credential',
                    reason: 'provider credential must not be logged',
                    replacement: '[REDACTED:credential]',
                },
            ],
        });
        const reasoningCompleted = ProviderStreamChunkSchema.parse({
            kind: 'reasoning_completed',
            requestId: 'provider_request_1',
            sequence: 3,
            sourceEventType: 'response.reasoning.completed',
            providerResponseId: 'resp_1',
            text: 'full reasoning trace',
        });

        expect(reasoningDelta).toMatchObject({ kind: 'reasoning_delta', delta: 'thinking...' });
        expect(reasoningDeltaWithRedactions).toMatchObject({
            kind: 'reasoning_delta',
            redactions: [{ classification: 'credential' }],
        });
        expect(reasoningCompleted).toMatchObject({ kind: 'reasoning_completed', text: 'full reasoning trace' });
    });

    it('rejects reasoning chunks missing required fields and rejects unknown fields under .strict()', () => {
        // malformed_input adversarial: missing requestId must throw
        expect(() =>
            ProviderStreamChunkSchema.parse({
                kind: 'reasoning_delta',
                sequence: 1,
                delta: 'x',
            }),
        ).toThrow();
        // reasoning_completed missing text must throw
        expect(() =>
            ProviderStreamChunkSchema.parse({
                kind: 'reasoning_completed',
                requestId: 'r',
                sequence: 1,
            }),
        ).toThrow();
        // unknown field rejected by .strict()
        expect(() =>
            ProviderStreamChunkSchema.parse({
                kind: 'reasoning_delta',
                requestId: 'r',
                sequence: 1,
                delta: 'x',
                surprise: true,
            }),
        ).toThrow();
        expect(() =>
            ProviderStreamChunkSchema.parse({
                kind: 'reasoning_completed',
                requestId: 'r',
                sequence: 1,
                text: 'x',
                surprise: true,
            }),
        ).toThrow();
    });

    it('accepts an optional reasoning string on ProviderMessageSchema without changing content semantics', () => {
        const withReasoning = ProviderMessageSchema.parse({
            messageId: 'message_1',
            role: 'assistant',
            content: 'answer',
            reasoning: 'private chain-of-thought',
        });
        const withoutReasoning = ProviderMessageSchema.parse({
            messageId: 'message_2',
            role: 'assistant',
            content: 'answer',
        });

        expect(withReasoning.reasoning).toBe('private chain-of-thought');
        expect(withoutReasoning.reasoning).toBeUndefined();
        // blast radius: response_completed arm still validates with a reasoning-bearing message
        const completedWithReasoning = ProviderStreamChunkSchema.parse({
            kind: 'response_completed',
            requestId: 'r',
            sequence: 4,
            message: {
                messageId: 'message_3',
                role: 'assistant',
                content: 'final answer',
                reasoning: 'final reasoning trace',
            },
            finishReason: 'stop',
        });
        expect(completedWithReasoning).toMatchObject({ kind: 'response_completed' });
        // reasoning must not be required and must not bleed into unrelated fields
        expect(() =>
            ProviderMessageSchema.parse({
                messageId: 'message_4',
                role: 'assistant',
                content: 'answer',
                reasoningRedactions: [],
            }),
        ).toThrow();
    });

    it('attaches provider stream chunks to agent events without storing credentials', () => {
        const event = ProviderStreamChunkSchema.parse({
            kind: 'text_delta',
            requestId: 'provider_request_1',
            sequence: 1,
            sourceEventType: 'response.output_text.delta',
            providerResponseId: 'resp_1',
            delta: 'hel',
        });
        const agentEvent = {
            type: 'task.progress',
            timestamp: '2026-06-08T10:00:00.000Z',
            sessionId: 'session_provider_event',
            message: 'hel',
            providerStreamChunk: event,
        };

        expect(ProviderStreamChunkSchema.parse(agentEvent.providerStreamChunk)).toEqual(event);
    });

    it('parses tool calls and correlates tool results with final messages', () => {
        const toolCall = ToolCallSchema.parse({
            toolCallId: 'tool_call_1',
            toolName: 'repo.read',
            argumentsJson: '{"path":"README.md"}',
            providerCallId: 'call_1',
            providerItemId: 'item_1',
        });
        const result = ToolResultSchema.parse({
            toolCallId: 'tool_call_1',
            status: 'completed',
            output: 'README contents',
        });
        const finalMessage = ProviderMessageSchema.parse({
            messageId: 'message_1',
            role: 'assistant',
            content: 'I read README.md.',
            toolCallIds: ['tool_call_1'],
        });

        const settlement = ToolCallSettlementSchema.parse({
            toolCall,
            result,
            finalMessage,
        });

        expect(settlement.result.toolCallId).toBe(settlement.toolCall.toolCallId);
        expect(settlement.finalMessage.toolCallIds).toContain(settlement.toolCall.toolCallId);
        expect(
            ToolCallSettlementSchema.safeParse({
                toolCall,
                result: { ...result, toolCallId: 'other_tool_call' },
                finalMessage,
            }).success,
        ).toBe(false);
    });

    it('rejects redaction metadata that retains raw values', () => {
        const redaction = RedactionMetadataSchema.parse({
            classification: 'credential',
            reason: 'provider credential must not be logged',
            replacement: '[REDACTED:credential]',
        });
        const withRawValue = RedactionMetadataSchema.safeParse({
            classification: 'credential',
            reason: 'provider credential must not be logged',
            replacement: '[REDACTED:credential]',
            rawValue: 'credential_sentinel_value',
        });

        expect(redaction.classification).toBe('credential');
        expect(withRawValue.success).toBe(false);
    });

    it('maps sample OpenAI Responses semantic events to provider-neutral chunks', () => {
        const openAiTextDelta = {
            type: 'response.output_text.delta',
            response_id: 'resp_1',
            sequence_number: 1,
            delta: 'hel',
        };
        const openAiFunctionArgumentsDone = {
            type: 'response.function_call_arguments.done',
            item_id: 'item_1',
            name: 'repo_read',
            output_index: 0,
            sequence_number: 2,
            arguments: '{"path":"README.md"}',
        };

        const textChunk = ProviderStreamChunkSchema.parse({
            kind: 'text_delta',
            requestId: 'provider_request_1',
            sequence: openAiTextDelta.sequence_number,
            sourceEventType: openAiTextDelta.type,
            providerResponseId: openAiTextDelta.response_id,
            delta: openAiTextDelta.delta,
        });
        const toolChunk = ProviderStreamChunkSchema.parse({
            kind: 'tool_call_completed',
            requestId: 'provider_request_1',
            sequence: openAiFunctionArgumentsDone.sequence_number,
            sourceEventType: openAiFunctionArgumentsDone.type,
            toolCall: {
                toolCallId: 'tool_call_item_1',
                toolName: openAiFunctionArgumentsDone.name,
                argumentsJson: openAiFunctionArgumentsDone.arguments,
                providerItemId: openAiFunctionArgumentsDone.item_id,
            },
        });

        expect(textChunk).toMatchObject({
            kind: 'text_delta',
            delta: 'hel',
            sourceEventType: 'response.output_text.delta',
        });
        expect(toolChunk).toMatchObject({
            kind: 'tool_call_completed',
            toolCall: {
                providerItemId: 'item_1',
                toolName: 'repo_read',
            },
        });
    });

    it('parses typed protocol errors without unstructured credential details', () => {
        const error = ProtocolErrorSchema.parse({
            code: 'provider_auth_failed',
            message: 'provider rejected credentials',
            retryable: false,
            redactions: [
                {
                    classification: 'credential',
                    reason: 'credential value omitted',
                    replacement: '[REDACTED:credential]',
                },
            ],
        });
        const withDetails = ProtocolErrorSchema.safeParse({
            code: 'provider_auth_failed',
            message: 'provider rejected credentials',
            retryable: false,
            rawCredential: 'credential_sentinel_value',
        });

        expect(error.redactions?.[0]?.classification).toBe('credential');
        expect(withDetails.success).toBe(false);
    });
});
