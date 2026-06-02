import { describe, expect, it } from 'vitest';
import {
    AgentEventSchema,
    PermissionDecisionSchema,
    PermissionRequestSchema,
    PermissionStatusSchema,
} from './schema.js';

describe('permission protocol schemas', () => {
    it('validates permission request, decision, and status', () => {
        expect(PermissionStatusSchema.parse('deny')).toBe('deny');

        const request = PermissionRequestSchema.parse({
            id: 'permission_1',
            action: 'file.write',
            reason: 'demo permission gate',
        });
        const decision = PermissionDecisionSchema.parse({
            requestId: request.id,
            status: 'deny',
            reason: 'default JSON permission decision',
        });

        const event = AgentEventSchema.parse({
            type: 'permission.requested',
            timestamp: '2026-06-02T10:00:00.000Z',
            sessionId: 'session_test',
            taskId: 'task_demo',
            message: 'permission requested: file.write',
            permissionRequest: request,
            permissionDecision: decision,
        });

        expect(event.permissionRequest?.action).toBe('file.write');
        expect(event.permissionDecision?.status).toBe('deny');
    });
});
