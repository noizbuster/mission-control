import { describe, expect, it } from 'vitest';
import { AgentEventSchema, RunCoordinatorEventMetadataSchema } from './schema.js';

describe('run coordinator protocol metadata', () => {
    it('parses explicit run commands and state transitions on agent events', () => {
        // Given
        const event = {
            type: 'run.command.received',
            timestamp: '2026-06-09T10:00:00.000Z',
            sessionId: 'session_run',
            message: 'run command: queue',
            run: {
                command: 'queue',
                state: 'idle',
                inputId: 'input_queued',
                messageId: 'message_queued',
                parentMessageId: 'message_parent',
                delivery: 'queue',
                graphId: 'graph_run',
                nodeId: 'node_queue',
            },
        };

        // When
        const parsed = AgentEventSchema.parse(event);

        // Then
        expect(parsed.run).toMatchObject({ command: 'queue', delivery: 'queue', parentMessageId: 'message_parent' });
        expect(RunCoordinatorEventMetadataSchema.parse(event.run).state).toBe('idle');
    });
});
