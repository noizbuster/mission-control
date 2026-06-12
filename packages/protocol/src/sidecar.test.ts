import { describe, expect, it } from 'vitest';
import {
    SIDECAR_PROTOCOL_V2_VERSION,
    SIDECAR_PROTOCOL_VERSION,
    SidecarCancelTaskCommandSchema,
    SidecarHandshakeCommandSchema,
    SidecarHandshakeResponseSchema,
    SidecarTaskCancelledResponseSchema,
    SidecarTaskFailedResponseSchema,
    SidecarWireResponseSchema,
} from './schema.js';

describe('sidecar protocol versions', () => {
    it('keeps v1 handshake compatibility limited to task.run', () => {
        const command = SidecarHandshakeCommandSchema.parse({
            type: 'handshake',
            id: 'handshake_v1',
            payload: {
                protocolVersion: SIDECAR_PROTOCOL_VERSION,
                clientName: 'mission-control-core',
            },
        });
        const response = SidecarHandshakeResponseSchema.parse({
            type: 'handshake_completed',
            id: 'handshake_v1',
            protocolVersion: SIDECAR_PROTOCOL_VERSION,
            capabilities: ['task.run'],
        });
        const rejected = SidecarHandshakeResponseSchema.safeParse({
            type: 'handshake_completed',
            id: 'handshake_v1',
            protocolVersion: SIDECAR_PROTOCOL_VERSION,
            capabilities: ['task.cancel'],
        });

        expect(command.payload.protocolVersion).toBe(SIDECAR_PROTOCOL_VERSION);
        expect(response.capabilities).toEqual(['task.run']);
        expect(rejected.success).toBe(false);
    });

    it('parses v2 negotiation, failure, and cancellation wire contracts', () => {
        const command = SidecarHandshakeCommandSchema.parse({
            type: 'handshake',
            id: 'handshake_v2',
            payload: {
                protocolVersion: SIDECAR_PROTOCOL_V2_VERSION,
                clientName: 'mission-control-core',
                requestedCapabilities: ['task.cancel'],
            },
        });
        const handshake = SidecarHandshakeResponseSchema.parse({
            type: 'handshake_completed',
            id: 'handshake_v2',
            protocolVersion: SIDECAR_PROTOCOL_V2_VERSION,
            capabilities: ['task.run', 'task.cancel'],
        });
        const cancelCommand = SidecarCancelTaskCommandSchema.parse({
            type: 'cancel_task',
            id: 'cancel_1',
            payload: {
                taskId: 'task_1',
                reason: 'user stopped task',
            },
        });
        const failed = SidecarTaskFailedResponseSchema.parse({
            type: 'task_failed',
            id: 'task_1',
            error: {
                code: 'sidecar_failed',
                message: 'provider process exited',
                retryable: false,
            },
        });
        const cancelled = SidecarTaskCancelledResponseSchema.parse({
            type: 'task_cancelled',
            id: 'task_1',
            reason: 'user stopped task',
        });

        expect(command.payload.requestedCapabilities).toEqual(['task.cancel']);
        expect(handshake.capabilities).toEqual(['task.run', 'task.cancel']);
        expect(cancelCommand.payload.taskId).toBe('task_1');
        expect(failed.error.retryable).toBe(false);
        expect(cancelled.reason).toBe('user stopped task');
        expect(SidecarWireResponseSchema.parse(failed)).toEqual(failed);
        expect(SidecarWireResponseSchema.parse(cancelled)).toEqual(cancelled);
    });
});
