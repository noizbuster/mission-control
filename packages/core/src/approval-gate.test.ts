import type { AgentEvent, PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { PermissionGate } from './approval-gate.js';

describe('PermissionGate', () => {
    it('blocks requires-approval decisions immediately in headless mode', async () => {
        const events: AgentEvent[] = [];
        const gate = new PermissionGate({
            resolveDecision: requiresApproval,
            emit: (event: AgentEvent) => {
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
            emit: (event: AgentEvent) => {
                events.push(event);
            },
            now: sequenceNow(['2026-06-11T00:00:00.000Z', '2026-06-11T00:00:01.000Z', '2026-06-11T00:00:02.000Z']),
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
            now: sequenceNow(['2026-06-11T00:00:00.000Z', '2026-06-11T00:00:01.000Z', '2026-06-11T00:00:02.000Z']),
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

    it('lists pending approvals and emits reply lifecycle events', async () => {
        const events: AgentEvent[] = [];
        const gate = new PermissionGate({
            emit: (event: AgentEvent) => {
                events.push(event);
            },
            now: sequenceNow(['2026-06-11T00:00:00.000Z', '2026-06-11T00:00:01.000Z', '2026-06-11T00:00:02.000Z']),
        });

        const pending = gate.requestPermission(scopedPatchRequest('permission_pending_list', 'src/app.ts'), {
            sessionId: 'session_pending_list',
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
        });
        await waitForPendingApproval(gate, 'approval_permission_pending_list');

        expect(gate.listPendingApprovals()).toMatchObject([
            {
                approvalId: 'approval_permission_pending_list',
                request: { action: 'file.patch' },
                record: { state: 'pending' },
            },
        ]);

        await gate.replyToApproval({
            approvalId: 'approval_permission_pending_list',
            reply: 'always',
            reason: 'persist within session',
        });

        await expect(pending).resolves.toMatchObject({ status: 'allow', reason: 'persist within session' });
        expect(events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['permission.replied', 'approval.updated', 'approval.resumed']),
        );
    });

    it('reuses always replies for later matching requests in the same session and rejects stale replies', async () => {
        const events: AgentEvent[] = [];
        const gate = new PermissionGate({
            emit: (event: AgentEvent) => {
                events.push(event);
            },
            now: sequenceNow(['2026-06-11T00:00:00.000Z', '2026-06-11T00:00:01.000Z', '2026-06-11T00:00:02.000Z']),
        });

        const initial = gate.requestPermission(scopedPatchRequest('permission_initial', 'src/app.ts'), {
            sessionId: 'session_always_scope',
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
        });
        await waitForPendingApproval(gate, 'approval_permission_initial');
        await gate.replyToApproval({
            approvalId: 'approval_permission_initial',
            reply: 'always',
            reason: 'allow this path',
        });
        await initial;

        await expect(
            gate.requestPermission(scopedPatchRequest('permission_followup', 'src/app.ts'), {
                sessionId: 'session_always_scope',
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            }),
        ).resolves.toMatchObject({ status: 'allow' });
        await expect(
            gate.replyToApproval({
                approvalId: 'approval_missing',
                reply: 'deny',
                reason: 'missing pending item',
            }),
        ).rejects.toMatchObject({ code: 'approval_not_found' });
        expect(events.map((event) => event.type)).toContain('permission.reply_not_found');
    });

    it('consumes configured once rules after the first matching request in a session', async () => {
        const gate = new PermissionGate({
            emit: () => {},
            now: sequenceNow(['2026-06-11T00:00:00.000Z', '2026-06-11T00:00:01.000Z']),
            rules: [{ permission: 'patch', pattern: 'src/**', decision: 'once', workspaceRoot: '/workspace' }],
            pendingApprovalBehavior: 'block',
        });

        await expect(
            gate.requestPermission(scopedPatchRequest('permission_once_first', 'src/app.ts'), {
                sessionId: 'session_once_scope',
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            }),
        ).resolves.toMatchObject({ status: 'allow', matchedRule: { decision: 'once' } });

        await expect(
            gate.requestPermission(scopedPatchRequest('permission_once_second', 'src/app.ts'), {
                sessionId: 'session_once_scope',
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            }),
        ).rejects.toMatchObject({ code: 'approval_required' });
    });

    it('refuses resume decision when no approval is pending at all', () => {
        const gate = new PermissionGate({
            resolveDecision: requiresApproval,
            emit: () => {},
            now: sequenceNow(['2026-06-11T00:00:00.000Z', '2026-06-11T00:00:01.000Z']),
        });

        expect(() =>
            gate.updateApproval({ approvalId: 'approval_never_pending', state: 'approved' }),
        ).toThrowError(expect.objectContaining({ code: 'approval_not_found' }));
        expect(gate.listPendingApprovals()).toHaveLength(0);
    });

    it('handles repeated deny decisions while blocked without corrupting state', async () => {
        const events: AgentEvent[] = [];
        const gate = new PermissionGate({
            resolveDecision: requiresApproval,
            emit: (event: AgentEvent) => {
                events.push(event);
            },
            now: sequenceNow([
                '2026-06-11T00:00:00.000Z',
                '2026-06-11T00:00:01.000Z',
                '2026-06-11T00:00:02.000Z',
                '2026-06-11T00:00:03.000Z',
            ]),
        });

        const pending = requestApproval(gate, 'permission_repeat_interrupt').catch(
            (error: unknown) => error,
        );
        await Promise.resolve();

        gate.updateApproval({
            approvalId: 'approval_permission_repeat_interrupt',
            state: 'denied',
            reason: 'first deny',
        });

        expect(() =>
            gate.updateApproval({
                approvalId: 'approval_permission_repeat_interrupt',
                state: 'denied',
                reason: 'second deny',
            }),
        ).toThrowError(expect.objectContaining({ code: 'approval_not_found' }));

        const error = await pending;
        expect(error).toMatchObject({
            code: 'approval_denied',
            requestId: 'permission_repeat_interrupt',
        });
        expect(gate.listPendingApprovals()).toHaveLength(0);
        const deniedRecords = events.filter(
            (event) => event.type === 'approval.blocked' && event.approvalRecord?.state === 'denied',
        );
        expect(deniedRecords).toHaveLength(1);
    });

    it('handles approve after run failure as approval_not_found when pending was consumed', async () => {
        const gate = new PermissionGate({
            resolveDecision: requiresApproval,
            emit: () => {},
            now: sequenceNow([
                '2026-06-11T00:00:00.000Z',
                '2026-06-11T00:00:01.000Z',
                '2026-06-11T00:00:02.000Z',
            ]),
        });

        const pending = requestApproval(gate, 'permission_fail_then_approve').catch(
            (error: unknown) => error,
        );
        await Promise.resolve();

        gate.updateApproval({
            approvalId: 'approval_permission_fail_then_approve',
            state: 'denied',
            reason: 'run failed before approval',
        });

        expect(() =>
            gate.updateApproval({
                approvalId: 'approval_permission_fail_then_approve',
                state: 'approved',
                reason: 'late approval after failure',
            }),
        ).toThrowError(expect.objectContaining({ code: 'approval_not_found' }));

        await expect(pending).resolves.toMatchObject({
            code: 'approval_denied',
        });
    });
});

function requiresApproval(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'requires_approval', reason: 'test requires approval' };
}

function requestApproval(gate: PermissionGate, id: string): Promise<PermissionDecision> {
    return gate.requestPermission(
        { id, action: 'command.run', reason: 'test requires approval' },
        { sessionId: `session_${id}`, modelProviderSelection: { providerID: 'local', modelID: 'local-echo' } },
    );
}

function scopedPatchRequest(id: string, path: string): PermissionRequest {
    return {
        id,
        action: 'file.patch',
        reason: `test patch ${path}`,
        permission: {
            kind: 'patch',
            patterns: [path],
            workspaceRoot: '/workspace',
        },
    };
}

function sequenceNow(values: readonly string[]): () => string {
    let index = 0;
    return () => {
        const value = values[index] ?? values.at(-1);
        index += 1;
        if (value === undefined) throw new Error('empty timestamp sequence');
        return value;
    };
}

async function waitForPendingApproval(gate: PermissionGate, approvalId: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        if (gate.listPendingApprovals().some((pending) => pending.approvalId === approvalId)) return;
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(`pending approval not ready: ${approvalId}`);
}
