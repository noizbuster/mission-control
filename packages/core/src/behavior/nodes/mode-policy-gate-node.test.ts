import type { AbgSignal, PolicyEffectRule } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { PLANNER_READONLY_POLICIES } from '../planner-workflow-graph.js';
import { runModePolicyGateNode } from './policy-gate-node.js';

type ModePolicyPayload = {
    readonly decision: string;
    readonly effect: string;
    readonly action: string;
    readonly resource: string;
    readonly reason?: string;
    readonly matchedRule?: PolicyEffectRule;
};

type ModeRunContext = {
    readonly graphId: string;
    readonly now: () => string;
    readonly modePolicies?: readonly PolicyEffectRule[];
};

async function collectSignals(signals: AsyncIterable<AbgSignal>): Promise<readonly AbgSignal[]> {
    const collected: AbgSignal[] = [];
    for await (const signal of signals) {
        collected.push(signal);
    }
    return collected;
}

function makeNode(
    action: string,
    resource: string,
): {
    readonly id: string;
    readonly kind: 'policy';
    readonly implementation: 'mode-policy-gate';
    readonly config: { readonly action: string; readonly resource: string };
} {
    return {
        id: 'mode-policy-check',
        kind: 'policy',
        implementation: 'mode-policy-gate',
        config: { action, resource },
    };
}

function makeContext(modePolicies?: readonly PolicyEffectRule[]): ModeRunContext {
    return {
        graphId: 'planner',
        now: () => '2026-06-22T00:00:00.000Z',
        ...(modePolicies !== undefined ? { modePolicies } : {}),
    };
}

function payloadOfEmit(signal: AbgSignal): ModePolicyPayload {
    if (signal.type !== 'emit') {
        throw new Error(`expected emit signal, got ${signal.type}`);
    }
    return signal.event.payload as ModePolicyPayload;
}

describe('runModePolicyGateNode — planner read-only enforcement (Task 3.2)', () => {
    describe('planner llm-actor attempts a source write (src/foo.ts)', () => {
        const signalsPromise = collectSignals(
            runModePolicyGateNode(makeNode('write', 'src/foo.ts'), makeContext(PLANNER_READONLY_POLICIES)),
        );

        it('emits started, policy.evaluated (deny), and failure (blocked) — never success', async () => {
            const signals = await signalsPromise;
            expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'failure']);
        });

        it('reports a deny effect and requires_approval-routing-incompatible decision on the emit', async () => {
            const [emitSignal] = (await signalsPromise).slice(1, 2);
            const payload = payloadOfEmit(emitSignal as AbgSignal);
            expect(payload.effect).toBe('deny');
            expect(payload.decision).toBe('deny');
            expect(payload.action).toBe('write');
            expect(payload.resource).toBe('src/foo.ts');
        });

        it('carries a human-readable reason citing the matched deny rule', async () => {
            const [emitSignal] = (await signalsPromise).slice(1, 2);
            const payload = payloadOfEmit(emitSignal as AbgSignal);
            expect(payload.reason).toContain('src/foo.ts');
            expect(payload.reason).toContain('denied');
            expect(payload.matchedRule?.effect).toBe('deny');
        });

        it('yields a policy_blocked failure error on the write', async () => {
            const failureSignal = (await signalsPromise).at(2);
            if (failureSignal === undefined || failureSignal.type !== 'failure') {
                throw new Error('expected failure signal');
            }
            const error = failureSignal.error as { code: string; action: string; resource: string };
            expect(error.code).toBe('policy_blocked');
            expect(error.action).toBe('write');
            expect(error.resource).toBe('src/foo.ts');
        });
    });

    it('allows the planner llm-actor to write .omo/plans/x.md', async () => {
        const signals = await collectSignals(
            runModePolicyGateNode(makeNode('write', '.omo/plans/x.md'), makeContext(PLANNER_READONLY_POLICIES)),
        );

        expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'success']);

        const payload = payloadOfEmit(signals[1] as AbgSignal);
        expect(payload.effect).toBe('allow');
        expect(payload.decision).toBe('allow');
        expect(payload.reason).toBeUndefined();

        const successSignal = signals[2];
        if (successSignal === undefined || successSignal.type !== 'success') {
            throw new Error('expected success signal');
        }
        const result = successSignal.result as { effect: string; decision: string };
        expect(result.effect).toBe('allow');
    });

    it('allows the planner llm-actor to write .omo/specs/feature.md', async () => {
        const signals = await collectSignals(
            runModePolicyGateNode(makeNode('write', '.omo/specs/feature.md'), makeContext(PLANNER_READONLY_POLICIES)),
        );

        expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'success']);
        expect(payloadOfEmit(signals[1] as AbgSignal).effect).toBe('allow');
    });

    it('denies writes to nested source paths (packages/core/src/index.ts)', async () => {
        const signals = await collectSignals(
            runModePolicyGateNode(
                makeNode('write', 'packages/core/src/index.ts'),
                makeContext(PLANNER_READONLY_POLICIES),
            ),
        );

        expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'failure']);
        expect(payloadOfEmit(signals[1] as AbgSignal).effect).toBe('deny');
    });

    it('yields failure when action config is missing', async () => {
        const node = {
            id: 'mode-policy-check',
            kind: 'policy' as const,
            implementation: 'mode-policy-gate' as const,
            config: { resource: 'src/foo.ts' },
        };
        const signals = await collectSignals(runModePolicyGateNode(node, makeContext(PLANNER_READONLY_POLICIES)));

        expect(signals.map((s) => s.type)).toEqual(['started', 'failure']);
        const failureSignal = signals[1];
        if (failureSignal === undefined || failureSignal.type !== 'failure') {
            throw new Error('expected failure signal');
        }
        expect((failureSignal.error as { code: string }).code).toBe('mode_policy_action_resource_required');
    });

    it('yields failure when resource config is missing', async () => {
        const node = {
            id: 'mode-policy-check',
            kind: 'policy' as const,
            implementation: 'mode-policy-gate' as const,
            config: { action: 'write' },
        };
        const signals = await collectSignals(runModePolicyGateNode(node, makeContext(PLANNER_READONLY_POLICIES)));

        expect(signals.map((s) => s.type)).toEqual(['started', 'failure']);
        const failureSignal = signals[1];
        if (failureSignal === undefined || failureSignal.type !== 'failure') {
            throw new Error('expected failure signal');
        }
        expect((failureSignal.error as { code: string }).code).toBe('mode_policy_action_resource_required');
    });

    it('defaults to ask (requires_approval) when no mode rule matches an action', async () => {
        const signals = await collectSignals(
            runModePolicyGateNode(makeNode('bash', 'rm -rf /'), makeContext(PLANNER_READONLY_POLICIES)),
        );

        expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'success']);
        const payload = payloadOfEmit(signals[1] as AbgSignal);
        expect(payload.effect).toBe('ask');
        expect(payload.decision).toBe('requires_approval');
        expect(payload.reason).toContain('rm -rf /');
        expect(payload.matchedRule).toBeUndefined();
    });

    it('routes an explicit ask rule to requires_approval with the rule cited', async () => {
        const askRules: readonly PolicyEffectRule[] = [{ action: 'edit', resource: '**', effect: 'ask' }];
        const signals = await collectSignals(
            runModePolicyGateNode(makeNode('edit', 'src/auth.ts'), makeContext(askRules)),
        );

        expect(signals.map((s) => s.type)).toEqual(['started', 'emit', 'success']);
        const payload = payloadOfEmit(signals[1] as AbgSignal);
        expect(payload.effect).toBe('ask');
        expect(payload.decision).toBe('requires_approval');
        expect(payload.matchedRule?.action).toBe('edit');
    });
});
