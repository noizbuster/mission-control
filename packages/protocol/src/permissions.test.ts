import { describe, expect, it } from 'vitest';
import {
    AgentEventSchema,
    ApprovalLifecycleStateSchema,
    ApprovalPolicyDecisionSchema,
    ApprovalRecordSchema,
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

    it('parses unified approval lifecycle records for permission-gated effects', () => {
        const record = ApprovalRecordSchema.parse({
            approvalId: 'approval_1',
            requestId: 'permission_1',
            policyDecision: 'requires_approval',
            state: 'pending',
            subject: {
                kind: 'tool',
                id: 'file.patch',
            },
            requestedAt: '2026-06-09T00:00:00.000Z',
            reason: 'patch requires human approval',
        });
        const approved = ApprovalRecordSchema.parse({
            ...record,
            state: 'approved',
            decidedAt: '2026-06-09T00:01:00.000Z',
        });
        const event = AgentEventSchema.parse({
            type: 'approval.requested',
            timestamp: '2026-06-09T00:00:00.000Z',
            sessionId: 'session_test',
            taskId: 'task_patch',
            approvalRecord: record,
        });

        expect(ApprovalPolicyDecisionSchema.parse('allow')).toBe('allow');
        expect(PermissionStatusSchema.parse('requires_approval')).toBe('requires_approval');
        expect(ApprovalLifecycleStateSchema.parse('cancelled')).toBe('cancelled');
        expect(record.state).toBe('pending');
        expect(approved.decidedAt).toBe('2026-06-09T00:01:00.000Z');
        expect(event.approvalRecord?.approvalId).toBe('approval_1');
    });

    it('rejects invalid approval lifecycle combinations', () => {
        const pendingWithDecisionTime = ApprovalRecordSchema.safeParse({
            approvalId: 'approval_1',
            requestId: 'permission_1',
            policyDecision: 'requires_approval',
            state: 'pending',
            subject: {
                kind: 'tool',
                id: 'file.patch',
            },
            requestedAt: '2026-06-09T00:00:00.000Z',
            decidedAt: '2026-06-09T00:01:00.000Z',
        });
        const approvedWithoutDecisionTime = ApprovalRecordSchema.safeParse({
            approvalId: 'approval_1',
            requestId: 'permission_1',
            policyDecision: 'requires_approval',
            state: 'approved',
            subject: {
                kind: 'tool',
                id: 'file.patch',
            },
            requestedAt: '2026-06-09T00:00:00.000Z',
        });
        const allowApprovalRecord = ApprovalRecordSchema.safeParse({
            approvalId: 'approval_1',
            requestId: 'permission_1',
            policyDecision: 'allow',
            state: 'approved',
            subject: {
                kind: 'tool',
                id: 'repo.read',
            },
            requestedAt: '2026-06-09T00:00:00.000Z',
            decidedAt: '2026-06-09T00:01:00.000Z',
        });
        const deniedButApproved = ApprovalRecordSchema.safeParse({
            approvalId: 'approval_1',
            requestId: 'permission_1',
            policyDecision: 'deny',
            state: 'approved',
            subject: {
                kind: 'tool',
                id: 'file.patch',
            },
            requestedAt: '2026-06-09T00:00:00.000Z',
            decidedAt: '2026-06-09T00:01:00.000Z',
        });

        expect(pendingWithDecisionTime.success).toBe(false);
        expect(approvedWithoutDecisionTime.success).toBe(false);
        expect(allowApprovalRecord.success).toBe(false);
        expect(deniedButApproved.success).toBe(false);
    });
});
