import type { AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { runHumanApprovalNode } from './human-approval-node.js';

async function collectSignals(signals: AsyncIterable<AbgSignal>): Promise<readonly AbgSignal[]> {
    const collected: AbgSignal[] = [];
    for await (const signal of signals) {
        collected.push(signal);
    }
    return collected;
}

const context = {
    graphId: 'g1',
    now: () => '2026-06-16T00:00:00.000Z',
};

describe('human-approval-node', () => {
    it('emits approval.requested and yields failure with human_approval_required', async () => {
        const node = {
            id: 'node1',
            kind: 'human-approval' as const,
        };

        const signals = await collectSignals(runHumanApprovalNode(node, context));

        expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'failure']);

        const emitSignal = signals[1];
        if (emitSignal === undefined || emitSignal.type !== 'emit') {
            throw new Error('Expected emit signal');
        }
        expect(emitSignal.event.type).toBe('approval.requested');
        const payload = emitSignal.event.payload as { approvalId: unknown; action: unknown };
        expect(payload.approvalId).toBe('approval_g1_node1');
        expect(payload.action).toBe('human-approval:node1');

        const failureSignal = signals[2];
        if (failureSignal === undefined || failureSignal.type !== 'failure') {
            throw new Error('Expected failure signal');
        }
        const error = failureSignal.error as { code: unknown; approvalId: unknown; action: unknown };
        expect(error.code).toBe('human_approval_required');
        expect(error.approvalId).toBe('approval_g1_node1');
        expect(error.action).toBe('human-approval:node1');
    });

    it('uses action from config when provided', async () => {
        const node = {
            id: 'node1',
            kind: 'human-approval' as const,
            config: {
                action: 'file.delete:/path/to/file',
            },
        };

        const signals = await collectSignals(runHumanApprovalNode(node, context));

        expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'failure']);

        const emitSignal = signals[1];
        if (emitSignal === undefined || emitSignal.type !== 'emit') {
            throw new Error('Expected emit signal');
        }
        const payload = emitSignal.event.payload as { action: unknown };
        expect(payload.action).toBe('file.delete:/path/to/file');

        const failureSignal = signals[2];
        if (failureSignal === undefined || failureSignal.type !== 'failure') {
            throw new Error('Expected failure signal');
        }
        const error = failureSignal.error as { action: unknown };
        expect(error.action).toBe('file.delete:/path/to/file');
    });

    it('includes reason in payload when provided in config', async () => {
        const node = {
            id: 'node1',
            kind: 'human-approval' as const,
            config: {
                action: 'file.write',
                reason: 'Attempting to write to a protected file',
            },
        };

        const signals = await collectSignals(runHumanApprovalNode(node, context));

        const emitSignal = signals[1];
        if (emitSignal === undefined || emitSignal.type !== 'emit') {
            throw new Error('Expected emit signal');
        }
        const payload = emitSignal.event.payload as { reason?: unknown };
        expect(payload.reason).toBe('Attempting to write to a protected file');
    });

    it('omits reason when not provided in config', async () => {
        const node = {
            id: 'node1',
            kind: 'human-approval' as const,
            config: {
                action: 'file.write',
            },
        };

        const signals = await collectSignals(runHumanApprovalNode(node, context));

        const emitSignal = signals[1];
        if (emitSignal === undefined || emitSignal.type !== 'emit') {
            throw new Error('Expected emit signal');
        }
        const payload = emitSignal.event.payload as { reason?: unknown };
        expect(payload.reason).toBeUndefined();
    });

    it('generates correct approvalId for different node and graph ids', async () => {
        const node = {
            id: 'approve-delete',
            kind: 'human-approval' as const,
        };
        const customContext = {
            graphId: 'graph-production-123',
            now: () => '2026-06-16T00:00:00.000Z',
        };

        const signals = await collectSignals(runHumanApprovalNode(node, customContext));

        const emitSignal = signals[1];
        if (emitSignal === undefined || emitSignal.type !== 'emit') {
            throw new Error('Expected emit signal');
        }
        const payload = emitSignal.event.payload as { approvalId: unknown };
        expect(payload.approvalId).toBe('approval_graph-production-123_approve-delete');
    });

    it('uses default action when config action is empty string', async () => {
        const node = {
            id: 'node1',
            kind: 'human-approval' as const,
            config: {
                action: '',
            },
        };

        const signals = await collectSignals(runHumanApprovalNode(node, context));

        const emitSignal = signals[1];
        if (emitSignal === undefined || emitSignal.type !== 'emit') {
            throw new Error('Expected emit signal');
        }
        const payload = emitSignal.event.payload as { action: unknown };
        expect(payload.action).toBe('human-approval:node1');
    });
});
