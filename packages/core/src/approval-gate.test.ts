import type { AgentEvent, PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { PermissionGate } from './approval-gate.js';

describe('PermissionGate', () => {
    it('blocks requires-approval decisions immediately in headless mode', async () => {
        const events: AgentEvent[] = [];
        const gate = new PermissionGate({
            resolveDecision: requiresApproval,
            emit: (event) => {
                events.push(event);
            },
            now: sequenceNow(['2026-06-11T00:00:00.000Z', '2026-06-11T00:00:01.000Z', '2026-06-11T00:00:02.000Z']),
            pendingApprovalBehavior: 'block',
        });

        await expect(
            gate.requestPermission(
                {
                    id: 'permission_command',
                    action: 'command.run',
                    reason: 'run command: pnpm test',
                },
                {
                    sessionId: 'session_headless',
                    modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                },
            ),
        ).rejects.toMatchObject({ code: 'approval_required' });

        expect(events.map((event) => event.type)).toEqual([
            'permission.requested',
            'approval.requested',
            'approval.blocked',
        ]);
        expect(events[1]?.approvalRecord).toMatchObject({
            policyDecision: 'requires_approval',
            state: 'pending',
            subject: { kind: 'tool', id: 'command.run' },
        });
        expect(events[2]?.approvalRecord).toMatchObject({
            policyDecision: 'requires_approval',
            state: 'cancelled',
            reason: 'test requires approval',
            decidedAt: '2026-06-11T00:00:02.000Z',
        });
    });

    it('refuses stale approval ids without settling the pending approval', async () => {
        const gate = new PermissionGate({
            resolveDecision: requiresApproval,
            emit: () => {},
            now: sequenceNow(['2026-06-11T00:00:00.000Z', '2026-06-11T00:00:01.000Z']),
        });

        const pending = requestApproval(gate, 'permission_stale');
        await Promise.resolve();

        expect(() =>
            gate.updateApproval({
                approvalId: 'approval_permission_stale_old',
                state: 'approved',
            }),
        ).toThrowError(expect.objectContaining({ code: 'approval_not_found' }));

        gate.updateApproval({
            approvalId: 'approval_permission_stale',
            state: 'approved',
            reason: 'fresh approval',
        });

        await expect(pending).resolves.toMatchObject({
            requestId: 'permission_stale',
            status: 'allow',
            reason: 'fresh approval',
        });
    });

    it('refuses duplicate approvals after the first decision settles', async () => {
        const events: AgentEvent[] = [];
        const gate = new PermissionGate({
            resolveDecision: requiresApproval,
            emit: (event) => {
                events.push(event);
            },
            now: sequenceNow([
                '2026-06-11T00:00:00.000Z',
                '2026-06-11T00:00:01.000Z',
                '2026-06-11T00:00:02.000Z',
            ]),
        });

        const pending = requestApproval(gate, 'permission_duplicate');
        await Promise.resolve();
        gate.updateApproval({
            approvalId: 'approval_permission_duplicate',
            state: 'approved',
            reason: 'first approval',
        });

        expect(() =>
            gate.updateApproval({
                approvalId: 'approval_permission_duplicate',
                state: 'approved',
                reason: 'duplicate approval',
            }),
        ).toThrowError(expect.objectContaining({ code: 'approval_not_found' }));

        await expect(pending).resolves.toMatchObject({
            requestId: 'permission_duplicate',
            status: 'allow',
            reason: 'first approval',
        });
        expect(events.filter((event) => event.type === 'approval.resumed')).toHaveLength(1);
    });

    it('refuses approve after a denied approval settles the request', async () => {
        const gate = new PermissionGate({
            resolveDecision: requiresApproval,
            emit: () => {},
            now: sequenceNow([
                '2026-06-11T00:00:00.000Z',
                '2026-06-11T00:00:01.000Z',
                '2026-06-11T00:00:02.000Z',
            ]),
        });

        const pending = requestApproval(gate, 'permission_denied_resume').catch((error: unknown) => error);
        await Promise.resolve();
        gate.updateApproval({
            approvalId: 'approval_permission_denied_resume',
            state: 'denied',
            reason: 'manual denial',
        });

        expect(() =>
            gate.updateApproval({
                approvalId: 'approval_permission_denied_resume',
                state: 'approved',
                reason: 'late approval',
            }),
        ).toThrowError(expect.objectContaining({ code: 'approval_not_found' }));

        await expect(pending).resolves.toMatchObject({
            code: 'approval_denied',
            requestId: 'permission_denied_resume',
            approvalId: 'approval_permission_denied_resume',
        });
    });
});

function requiresApproval(request: PermissionRequest): PermissionDecision {
    return {
        requestId: request.id,
        status: 'requires_approval',
        reason: 'test requires approval',
    };
}

function requestApproval(gate: PermissionGate, id: string): Promise<PermissionDecision> {
    return gate.requestPermission(
        {
            id,
            action: 'command.run',
            reason: 'test requires approval',
        },
        {
            sessionId: `session_${id}`,
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
        },
    );
}

function sequenceNow(values: readonly string[]): () => string {
    let index = 0;
    return () => {
        const value = values[index] ?? values.at(-1);
        index += 1;
        if (value === undefined) {
            throw new Error('empty timestamp sequence');
        }
        return value;
    };
}
