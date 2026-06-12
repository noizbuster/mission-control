import { describe, expect, it } from 'vitest';
import {
    AgentEventEnvelopeSchema,
    AgentEventLogSchema,
    AgentEventSchema,
    AgentEventTypeSchema,
    AgentSnapshotSchema,
    EventDurabilitySchema,
    NativeSidecarStatusSchema,
    ReplayCursorSchema,
    SidecarCapabilitySchema,
    SidecarHandshakeResponseSchema,
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
        expect(AgentEventTypeSchema.parse('model.call.failed')).toBe('model.call.failed');
    });

    it('keeps existing protocol event baseline before ABG protocol expansion', () => {
        const event = AgentEventSchema.parse({
            type: 'permission.requested',
            timestamp: '2026-06-02T10:00:00.000Z',
            sessionId: 'session_existing',
            taskId: 'task_existing',
            message: 'permission requested: task.run',
            nativeSidecarStatus: 'mock',
            permissionRequest: {
                id: 'permission_task_existing',
                action: 'task.run',
                reason: 'baseline permission gate',
            },
            permissionDecision: {
                requestId: 'permission_task_existing',
                status: 'deny',
                reason: 'default JSON permission decision',
            },
        });

        expect(event).toMatchObject({
            type: 'permission.requested',
            taskId: 'task_existing',
            permissionDecision: {
                status: 'deny',
            },
        });
    });

    it('rejects unknown event type', () => {
        const parsed = AgentEventSchema.safeParse({
            type: 'task.unknown',
            timestamp: '2026-06-02T10:00:00.000Z',
        });

        expect(parsed.success).toBe(false);
    });

    it('parses durable event envelopes around existing agent events', () => {
        const envelope = AgentEventEnvelopeSchema.parse({
            eventId: 'event_1',
            sequence: 0,
            createdAt: '2026-06-02T10:00:00.000Z',
            sessionId: 'session_1',
            durability: 'durable',
            causationId: 'event_parent',
            correlationId: 'correlation_1',
            event: {
                type: 'task.completed',
                timestamp: '2026-06-02T10:00:00.000Z',
                sessionId: 'session_1',
                taskId: 'task_1',
                message: 'demo completed',
            },
        });

        expect(envelope).toMatchObject({
            eventId: 'event_1',
            sequence: 0,
            durability: 'durable',
            event: {
                type: 'task.completed',
            },
        });
        expect(EventDurabilitySchema.parse('ephemeral')).toBe('ephemeral');
    });

    it('rejects malformed event envelopes and invalid durability values', () => {
        const missingEventId = AgentEventEnvelopeSchema.safeParse({
            sequence: 0,
            createdAt: '2026-06-02T10:00:00.000Z',
            sessionId: 'session_1',
            durability: 'durable',
            event: {
                type: 'task.completed',
                timestamp: '2026-06-02T10:00:00.000Z',
            },
        });
        const invalidDurability = AgentEventEnvelopeSchema.safeParse({
            eventId: 'event_1',
            sequence: 0,
            createdAt: '2026-06-02T10:00:00.000Z',
            sessionId: 'session_1',
            durability: 'archived',
            event: {
                type: 'task.completed',
                timestamp: '2026-06-02T10:00:00.000Z',
            },
        });

        expect(missingEventId.success).toBe(false);
        expect(invalidDurability.success).toBe(false);
    });

    it('rejects non-monotonic event log sequences', () => {
        const parsed = AgentEventLogSchema.safeParse([
            {
                eventId: 'event_1',
                sequence: 2,
                createdAt: '2026-06-02T10:00:00.000Z',
                sessionId: 'session_1',
                durability: 'durable',
                event: {
                    type: 'task.started',
                    timestamp: '2026-06-02T10:00:00.000Z',
                },
            },
            {
                eventId: 'event_2',
                sequence: 1,
                createdAt: '2026-06-02T10:00:01.000Z',
                sessionId: 'session_1',
                durability: 'durable',
                event: {
                    type: 'task.completed',
                    timestamp: '2026-06-02T10:00:01.000Z',
                },
            },
        ]);

        expect(parsed.success).toBe(false);
    });

    it('round trips replay cursors through stable JSON', () => {
        const cursor = ReplayCursorSchema.parse({
            sessionId: 'session_1',
            sequence: 42,
            eventId: 'event_42',
        });
        const serialized = JSON.stringify(cursor);

        expect(ReplayCursorSchema.parse(JSON.parse(serialized))).toEqual(cursor);
        expect(serialized).toBe('{"sessionId":"session_1","sequence":42,"eventId":"event_42"}');
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

    it('parses sidecar protocol handshake and native status boundaries', () => {
        const handshake = SidecarHandshakeResponseSchema.parse({
            type: 'handshake_completed',
            id: 'handshake_1',
            protocolVersion: 1,
            capabilities: ['task.run'],
        });
        const output = SidecarTaskOutputSchema.parse({
            id: 'task_1',
            message: 'completed by rust sidecar',
            nativeSidecarStatus: 'native',
        });

        expect(handshake.capabilities).toEqual(['task.run']);
        expect(SidecarCapabilitySchema.safeParse('command.run').success).toBe(false);
        expect(NativeSidecarStatusSchema.parse('native')).toBe('native');
        expect(output.nativeSidecarStatus).toBe('native');
    });

    it('preserves provider stream chunks on agent events', () => {
        const event = AgentEventSchema.parse({
            type: 'task.progress',
            timestamp: '2026-06-08T10:00:00.000Z',
            sessionId: 'session_provider_chunk',
            message: 'hel',
            providerStreamChunk: {
                kind: 'text_delta',
                requestId: 'request_provider_chunk',
                sequence: 1,
                delta: 'hel',
            },
        });

        expect(event.providerStreamChunk).toMatchObject({
            kind: 'text_delta',
            delta: 'hel',
        });
    });

    it('keeps provider model metadata optional on existing events and snapshots', () => {
        const event = AgentEventSchema.parse({
            type: 'task.completed',
            timestamp: '2026-06-02T10:00:00.000Z',
            taskId: 'task_1',
            message: 'demo completed',
        });
        const snapshot = AgentSnapshotSchema.parse({
            sessionId: 'session_1',
            status: 'running',
            startedAt: '2026-06-02T10:00:00.000Z',
            runningTaskCount: 0,
            completedTaskCount: 0,
            failedTaskCount: 0,
            nativeSidecarStatus: 'mock',
        });

        expect(event.modelProviderSelection).toBeUndefined();
        expect(snapshot.modelProviderSelection).toBeUndefined();
    });
});
