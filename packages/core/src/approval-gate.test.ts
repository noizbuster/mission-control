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
});

function requiresApproval(request: PermissionRequest): PermissionDecision {
    return {
        requestId: request.id,
        status: 'requires_approval',
        reason: 'test requires approval',
    };
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
