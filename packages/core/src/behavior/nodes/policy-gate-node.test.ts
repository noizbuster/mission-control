import type { AbgPolicySpec, AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { runPolicyGateNode } from './policy-gate-node.js';

async function collectSignals(signals: AsyncIterable<AbgSignal>): Promise<readonly AbgSignal[]> {
    const collected: AbgSignal[] = [];
    for await (const signal of signals) {
        collected.push(signal);
    }
    return collected;
}

function createContext(policies?: readonly AbgPolicySpec[]): {
    graphId: string;
    now: () => string;
    policies?: readonly AbgPolicySpec[];
} {
    return {
        graphId: 'g1',
        now: () => '2026-06-16T00:00:00.000Z',
        ...(policies !== undefined ? { policies } : {}),
    };
}

describe('policy-gate-node', () => {
    it('emits policy.evaluated with deny decision when a deny policy exists', async () => {
        const node = {
            id: 'policy-check',
            kind: 'policy' as const,
            implementation: 'policy-gate',
            config: {
                capability: 'file.write',
            },
        };
        const context = createContext([
            {
                id: 'deny-writes',
                capability: 'file.write',
                decision: 'deny',
                reason: 'no writes allowed',
            },
        ]);

        const signals = await collectSignals(runPolicyGateNode(node, context));

        expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'success']);

        const emitSignal = signals[1];
        if (emitSignal === undefined || emitSignal.type !== 'emit') {
            throw new Error('Expected emit signal');
        }
        expect(emitSignal.event.type).toBe('policy.evaluated');
        const payload = emitSignal.event.payload as { decision: unknown; capability: unknown };
        expect(payload.decision).toBe('deny');
        expect(payload.capability).toBe('file.write');

        const successSignal = signals[2];
        if (successSignal === undefined || successSignal.type !== 'success') {
            throw new Error('Expected success signal');
        }
        const result = successSignal.result as { decision: unknown; capability: unknown };
        expect(result.decision).toBe('deny');
        expect(result.capability).toBe('file.write');
    });

    it('emits policy.evaluated with requires_approval decision when a requires_approval policy exists', async () => {
        const node = {
            id: 'policy-check',
            kind: 'policy' as const,
            implementation: 'policy-gate',
            config: {
                capability: 'file.delete',
            },
        };
        const context = createContext([
            {
                id: 'approve-deletes',
                capability: 'file.delete',
                decision: 'requires_approval',
                reason: 'destructive operation',
            },
        ]);

        const signals = await collectSignals(runPolicyGateNode(node, context));

        expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'success']);

        const emitSignal = signals[1];
        if (emitSignal === undefined || emitSignal.type !== 'emit') {
            throw new Error('Expected emit signal');
        }
        expect(emitSignal.event.type).toBe('policy.evaluated');
        const payload = emitSignal.event.payload as { decision: unknown; capability: unknown; reason?: unknown };
        expect(payload.decision).toBe('requires_approval');
        expect(payload.capability).toBe('file.delete');
        expect(payload.reason).toBe('destructive operation');

        const successSignal = signals[2];
        if (successSignal === undefined || successSignal.type !== 'success') {
            throw new Error('Expected success signal');
        }
        const result = successSignal.result as { decision: unknown; capability: unknown; reason?: unknown };
        expect(result.decision).toBe('requires_approval');
        expect(result.capability).toBe('file.delete');
        expect(result.reason).toBe('destructive operation');
    });

    it('emits policy.evaluated with allow decision when no matching policy exists', async () => {
        const node = {
            id: 'policy-check',
            kind: 'policy' as const,
            implementation: 'policy-gate',
            config: {
                capability: 'file.read',
            },
        };
        const context = createContext([
            {
                id: 'deny-writes',
                capability: 'file.write',
                decision: 'deny',
            },
        ]);

        const signals = await collectSignals(runPolicyGateNode(node, context));

        expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'success']);

        const emitSignal = signals[1];
        if (emitSignal === undefined || emitSignal.type !== 'emit') {
            throw new Error('Expected emit signal');
        }
        expect(emitSignal.event.type).toBe('policy.evaluated');
        const payload = emitSignal.event.payload as { decision: unknown; capability: unknown };
        expect(payload.decision).toBe('allow');
        expect(payload.capability).toBe('file.read');

        const successSignal = signals[2];
        if (successSignal === undefined || successSignal.type !== 'success') {
            throw new Error('Expected success signal');
        }
        const result = successSignal.result as { decision: unknown; capability: unknown };
        expect(result.decision).toBe('allow');
        expect(result.capability).toBe('file.read');
    });

    it('emits policy.evaluated with allow decision when policies array is empty', async () => {
        const node = {
            id: 'policy-check',
            kind: 'policy' as const,
            implementation: 'policy-gate',
            config: {
                capability: 'file.read',
            },
        };
        const context = createContext([]);

        const signals = await collectSignals(runPolicyGateNode(node, context));

        expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'success']);

        const emitSignal = signals[1];
        if (emitSignal === undefined || emitSignal.type !== 'emit') {
            throw new Error('Expected emit signal');
        }
        expect(emitSignal.event.type).toBe('policy.evaluated');
        const payload = emitSignal.event.payload as { decision: unknown; capability: unknown };
        expect(payload.decision).toBe('allow');

        const successSignal = signals[2];
        if (successSignal === undefined || successSignal.type !== 'success') {
            throw new Error('Expected success signal');
        }
        const result = successSignal.result as { decision: unknown };
        expect(result.decision).toBe('allow');
    });

    it('yields failure when capability config is missing and no capabilities array exists', async () => {
        const node = {
            id: 'policy-check',
            kind: 'policy' as const,
            implementation: 'policy-gate',
        };
        const context = createContext();

        const signals = await collectSignals(runPolicyGateNode(node, context));

        expect(signals.map((s) => s.type)).toEqual(['started', 'failure']);

        const failureSignal = signals[1];
        if (failureSignal === undefined || failureSignal.type !== 'failure') {
            throw new Error('Expected failure signal');
        }
        const error = failureSignal.error as { code: unknown };
        expect(error.code).toBe('policy_capability_required');
    });

    it('yields failure when capability config is empty string and capabilities array is empty', async () => {
        const node = {
            id: 'policy-check',
            kind: 'policy' as const,
            implementation: 'policy-gate',
            config: {
                capability: '',
            },
            capabilities: [],
        };
        const context = createContext();

        const signals = await collectSignals(runPolicyGateNode(node, context));

        expect(signals.map((s) => s.type)).toEqual(['started', 'failure']);

        const failureSignal = signals[1];
        if (failureSignal === undefined || failureSignal.type !== 'failure') {
            throw new Error('Expected failure signal');
        }
        const error = failureSignal.error as { code: unknown };
        expect(error.code).toBe('policy_capability_required');
    });

    it('uses capabilities array as fallback when config is missing', async () => {
        const node = {
            id: 'policy-check',
            kind: 'policy' as const,
            implementation: 'policy-gate',
            capabilities: ['file.write'],
        };
        const context = createContext([
            {
                id: 'deny-writes',
                capability: 'file.write',
                decision: 'deny',
                reason: 'no writes',
            },
        ]);

        const signals = await collectSignals(runPolicyGateNode(node, context));

        expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'success']);

        const emitSignal = signals[1];
        if (emitSignal === undefined || emitSignal.type !== 'emit') {
            throw new Error('Expected emit signal');
        }
        const payload = emitSignal.event.payload as { decision: unknown; capability: unknown };
        expect(payload.decision).toBe('deny');
        expect(payload.capability).toBe('file.write');
    });

    it('deny takes precedence over requires_approval when both policies exist', async () => {
        const node = {
            id: 'policy-check',
            kind: 'policy' as const,
            implementation: 'policy-gate',
            config: {
                capability: 'file.write',
            },
        };
        const context = createContext([
            {
                id: 'approve-writes',
                capability: 'file.write',
                decision: 'requires_approval',
                reason: 'needs approval',
            },
            {
                id: 'deny-writes',
                capability: 'file.write',
                decision: 'deny',
                reason: 'not allowed',
            },
        ]);

        const signals = await collectSignals(runPolicyGateNode(node, context));

        const emitSignal = signals[1];
        if (emitSignal === undefined || emitSignal.type !== 'emit') {
            throw new Error('Expected emit signal');
        }
        const payload = emitSignal.event.payload as { decision: unknown; reason?: unknown };
        expect(payload.decision).toBe('deny');
        expect(payload.reason).toBe('not allowed');
    });
});
