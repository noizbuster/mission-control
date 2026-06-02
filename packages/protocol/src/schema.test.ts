import { describe, expect, it } from 'vitest';
import {
    AgentEventSchema,
    AgentEventTypeSchema,
    AgentSnapshotSchema,
    SidecarTaskInputSchema,
    SidecarTaskOutputSchema,
} from './schema.js';

describe('protocol schemas', () => {
    it('exports schemas and types for required protocol events', () => {
        const event = AgentEventSchema.parse({
            type: 'task.completed',
            timestamp: '2026-06-02T10:00:00.000Z',
            taskId: 'task_1',
            message: 'demo completed',
        });

        expect(event.type).toBe('task.completed');
        expect(AgentEventTypeSchema.parse('native.warning')).toBe('native.warning');
    });

    it('rejects unknown event type', () => {
        const parsed = AgentEventSchema.safeParse({
            type: 'task.unknown',
            timestamp: '2026-06-02T10:00:00.000Z',
        });

        expect(parsed.success).toBe(false);
    });

    it('parses snapshots and sidecar task boundaries', () => {
        const snapshot = AgentSnapshotSchema.parse({
            sessionId: 'session_1',
            status: 'running',
            startedAt: '2026-06-02T10:00:00.000Z',
            runningTaskCount: 1,
            completedTaskCount: 0,
            failedTaskCount: 0,
            nativeSidecarStatus: 'mock',
        });
        const input = SidecarTaskInputSchema.parse({
            id: 'task_1',
            payload: {
                label: 'demo',
            },
        });
        const output = SidecarTaskOutputSchema.parse({
            id: 'task_1',
            message: 'completed by mock sidecar',
        });

        expect(snapshot.sessionId).toBe('session_1');
        expect(input.payload.label).toBe('demo');
        expect(output.message).toBe('completed by mock sidecar');
    });
});
