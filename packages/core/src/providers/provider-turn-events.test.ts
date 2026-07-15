import type { ProviderStreamChunk } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { redactProviderChunk } from './provider-turn-events';

describe('redactProviderChunk idempotency', () => {
    // Redacting an already-redacted chunk must be a fixed point:
    //   redactProviderChunk(redactProviderChunk(c)) deep-equals redactProviderChunk(c).
    //
    // This invariant is what makes single-site redaction safe: the :65 failed-path
    // in provider-turn-runner.ts redacts the chunk before eventForProviderChunk
    // re-redacts it (a double-redact), and removing the :124 per-chunk loop redact
    // means the completed chunk arrives raw at eventForProviderChunk. Both paths
    // are only correct because a second redaction is a no-op on already-redacted
    // text and the redactions array is preserved by the spread in redactionsForText.
    const SECRET = 'sk-idempotency_test_token';
    const CHUNK_FIXTURES: ReadonlyArray<{ readonly label: string; readonly chunk: ProviderStreamChunk }> = [
        {
            label: 'text_delta',
            chunk: {
                kind: 'text_delta',
                requestId: 'req_test',
                sequence: 1,
                delta: `stream ${SECRET}`,
            },
        },
        {
            label: 'tool_call_delta',
            chunk: {
                kind: 'tool_call_delta',
                requestId: 'req_test',
                sequence: 2,
                toolCallId: 'tool_delta_1',
                argumentsDelta: `{"secret":"${SECRET}"}`,
            },
        },
        {
            label: 'tool_call_completed',
            chunk: {
                kind: 'tool_call_completed',
                requestId: 'req_test',
                sequence: 3,
                toolCall: {
                    toolCallId: 'tool_completed_1',
                    toolName: 'repo.read',
                    argumentsJson: `{"key":"${SECRET}"}`,
                },
            },
        },
        {
            label: 'response_completed',
            chunk: {
                kind: 'response_completed',
                requestId: 'req_test',
                sequence: 4,
                message: {
                    messageId: 'msg_test',
                    role: 'assistant',
                    content: `final ${SECRET}`,
                },
                finishReason: 'stop',
            },
        },
        {
            label: 'response_failed',
            chunk: {
                kind: 'response_failed',
                requestId: 'req_test',
                sequence: 5,
                error: {
                    code: 'unknown',
                    message: `provider failed ${SECRET}`,
                    retryable: false,
                },
            },
        },
        {
            label: 'response_started',
            chunk: {
                kind: 'response_started',
                requestId: 'req_test',
                sequence: 0,
                sourceEventType: 'test.started',
            },
        },
    ];

    it.each(CHUNK_FIXTURES)('is idempotent for $label', ({ chunk }) => {
        const once = redactProviderChunk(chunk);
        const twice = redactProviderChunk(once);
        expect(twice).toEqual(once);
    });

    it('redacts the credential on the first pass for text-bearing chunks', () => {
        // Proves the test is not vacuous: the first redaction actually changes the chunk.
        const chunk: ProviderStreamChunk = {
            kind: 'text_delta',
            requestId: 'req_test',
            sequence: 1,
            delta: `stream ${SECRET}`,
        };
        const redacted = redactProviderChunk(chunk);
        expect(redacted).not.toEqual(chunk);
        expect(JSON.stringify(redacted)).not.toContain(SECRET);
    });

    it('redacts reasoning copied into a completed provider message', () => {
        // Given
        const chunk: ProviderStreamChunk = {
            kind: 'response_completed',
            requestId: 'req_reasoning',
            sequence: 1,
            message: {
                messageId: 'msg_reasoning',
                role: 'assistant',
                content: 'ordinary response',
                reasoning: `private reasoning ${SECRET}`,
            },
            finishReason: 'stop',
        };

        // When
        const redacted = redactProviderChunk(chunk);

        // Then
        expect(JSON.stringify(redacted)).toContain('[REDACTED_CREDENTIAL]');
        expect(JSON.stringify(redacted)).not.toContain(SECRET);
    });
});
