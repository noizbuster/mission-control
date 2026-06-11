import { describe, expect, it } from 'vitest';
import { AgentMessageSchema, ProviderRequestSchema } from './index.js';

describe('agent message protocol schema', () => {
    it('keeps existing user assistant and system message roles parseable', () => {
        // Given
        const messages = [
            { role: 'system', content: 'Use concise answers.' },
            { role: 'user', content: 'Read README.md.' },
            { role: 'assistant', content: 'I will inspect the repository.' },
        ];

        // When
        const parsed = messages.map((message) => AgentMessageSchema.parse(message));

        // Then
        expect(parsed.map((message) => message.role)).toEqual(['system', 'user', 'assistant']);
    });

    it('parses model-visible tool result messages on provider requests', () => {
        // Given
        const request = {
            requestId: 'provider_request_1',
            sessionId: 'session_1',
            turnId: 'turn_1',
            providerID: 'openai',
            modelID: 'gpt-5',
            messages: [
                { role: 'user', content: 'Read README.md.' },
                {
                    role: 'tool',
                    toolCallId: 'tool_call_1',
                    status: 'completed',
                    output: 'README contents',
                    redactions: [
                        {
                            classification: 'model_output',
                            reason: 'bounded model-visible output',
                            replacement: '[REDACTED:model_output]',
                        },
                    ],
                },
            ],
        };

        // When
        const parsed = ProviderRequestSchema.parse(request);

        // Then
        expect(parsed.messages[1]).toMatchObject({
            role: 'tool',
            toolCallId: 'tool_call_1',
            status: 'completed',
            output: 'README contents',
        });
    });

    it('preserves provider tool-call transcript metadata on assistant messages', () => {
        // Given
        const message = {
            role: 'assistant',
            content: 'I need README.md.',
            providerToolCalls: [
                {
                    providerID: 'openai',
                    toolCallId: 'call_read',
                    providerCallId: 'call_read',
                    providerItemId: 'fc_read',
                    toolName: 'repo_read',
                    argumentsJson: '{"path":"README.md"}',
                },
            ],
        };

        // When
        const parsed = AgentMessageSchema.parse(message);

        // Then
        expect(parsed).toMatchObject(message);
    });

    it('rejects malformed tool result messages with mismatched error shape', () => {
        // Given
        const malformed = {
            role: 'tool',
            toolCallId: 'tool_call_1',
            status: 'failed',
            error: {
                code: 'provider_timeout',
                message: 'wrong error family for a tool result',
                retryable: true,
            },
            rawCredential: 'credential_sentinel_value',
        };

        // When
        const parsed = AgentMessageSchema.safeParse(malformed);

        // Then
        expect(parsed.success).toBe(false);
    });
});
