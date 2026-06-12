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

    it('parses failed and approval-blocked run states with failure metadata', () => {
        // Given
        const failedEvent = {
            type: 'run.failed',
            timestamp: '2026-06-09T10:00:00.000Z',
            sessionId: 'session_run',
            message: 'provider exploded',
            run: {
                command: 'run',
                state: 'failed',
                runId: 'run_failed',
                reason: 'provider exploded',
                errorCode: 'unknown',
            },
        };
        const blockedEvent = {
            type: 'run.blocked',
            timestamp: '2026-06-09T10:00:01.000Z',
            sessionId: 'session_run',
            message: 'waiting for approval',
            run: {
                command: 'run',
                state: 'blocked_on_approval',
                runId: 'run_blocked',
                toolCallId: 'tool_call_patch',
                reason: 'waiting for approval',
                errorCode: 'tool_failed',
            },
        };

        // When
        const failed = AgentEventSchema.parse(failedEvent);
        const blocked = AgentEventSchema.parse(blockedEvent);

        // Then
        expect(failed.run).toMatchObject({ state: 'failed', errorCode: 'unknown' });
        expect(blocked.run).toMatchObject({ state: 'blocked_on_approval', errorCode: 'tool_failed' });
    });
});
