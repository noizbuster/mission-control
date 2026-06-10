import { describe, expect, it } from 'vitest';
import { AgentEventSchema, TranscriptEventMetadataSchema } from './index.js';

describe('transcript event metadata', () => {
    it('parses prompt admission metadata with explicit transcript links', () => {
        // Given
        const transcript = {
            inputId: 'input_1',
            messageId: 'message_1',
            parentMessageId: 'message_parent',
            delivery: 'steer',
            visibility: 'pending',
            providerTurnId: 'turn_1',
            toolCallId: 'tool_call_1',
            graphId: 'graph_1',
            nodeId: 'node_1',
        };

        // When
        const event = AgentEventSchema.parse({
            type: 'prompt.admitted',
            timestamp: '2026-06-06T10:00:00.000Z',
            sessionId: 'session_transcript',
            message: 'implement admission',
            transcript,
        });

        // Then
        expect(event.transcript).toEqual(transcript);
    });

    it('rejects invalid delivery and visibility values', () => {
        expect(() =>
            TranscriptEventMetadataSchema.parse({
                inputId: 'input_1',
                messageId: 'message_1',
                delivery: 'immediate',
                visibility: 'pending',
            }),
        ).toThrow();
        expect(() =>
            TranscriptEventMetadataSchema.parse({
                inputId: 'input_1',
                messageId: 'message_1',
                delivery: 'queue',
                visibility: 'visible',
            }),
        ).toThrow();
    });
});
