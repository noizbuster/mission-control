import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createBlackboard } from '../../memory/blackboard.js';
import {
    aggregateCriticEvaluation,
    type CriticEvaluationVerdict,
    normalizeEvaluationInput,
    runCriticNode,
} from './critic-node.js';

const NOW = '2026-06-16T00:00:00.000Z';

function baseContext(blackboard: ReturnType<typeof createBlackboard>) {
    return { graphId: 'g1', now: () => NOW, blackboard };
}

function collect(signals: readonly AbgSignal[]) {
    const success = signals.find((s): s is Extract<AbgSignal, { type: 'success' }> => s.type === 'success');
    const failure = signals.find((s): s is Extract<AbgSignal, { type: 'failure' }> => s.type === 'failure');
    const evaluated = signals.find(
        (s): s is Extract<AbgSignal, { type: 'emit' }> => s.type === 'emit' && s.event.type === 'critic.evaluated',
    );
    return { success, failure, evaluated };
}

describe('runCriticNode', () => {
    it('passes a draft that cites file:line evidence', async () => {
        const blackboard = createBlackboard();
        blackboard.setMessages([
            { role: 'user', content: 'fix the bug' },
            {
                role: 'assistant',
                content: 'Fixed the null check in packages/core/src/agent-runtime.ts:42 and verified.',
            },
        ]);
        const signals: AbgSignal[] = [];
        for await (const signal of runCriticNode({ id: 'critic', kind: 'condition' }, baseContext(blackboard))) {
            signals.push(signal);
        }
        const { success, evaluated } = collect(signals);
        expect(success?.type).toBe('success');
        expect((success?.result as { passed: boolean }).passed).toBe(true);
        expect((evaluated?.event.payload as { passed: boolean }).passed).toBe(true);
        expect(blackboard.get('critic.passed')).toBe(true);
    });

    it('fails a non-answer draft and records the issue', async () => {
        const blackboard = createBlackboard();
        blackboard.setMessages([{ role: 'assistant', content: "I don't know how to fix this." }]);
        const signals: AbgSignal[] = [];
        for await (const signal of runCriticNode({ id: 'critic', kind: 'condition' }, baseContext(blackboard))) {
            signals.push(signal);
        }
        const { success } = collect(signals);
        const verdict = success?.result as { passed: boolean; issues: { check: string }[] } | undefined;
        expect(verdict?.passed).toBe(false);
        expect(verdict?.issues.map((issue) => issue.check)).toContain('not_non_answer');
        expect(blackboard.get('critic.passed')).toBe(false);
    });

    it('fails a draft that cites no evidence', async () => {
        const blackboard = createBlackboard();
        blackboard.setMessages([{ role: 'assistant', content: 'It should work now.' }]);
        const signals: AbgSignal[] = [];
        for await (const signal of runCriticNode({ id: 'critic', kind: 'condition' }, baseContext(blackboard))) {
            signals.push(signal);
        }
        const verdict = collect(signals).success?.result as
            | { passed: boolean; issues: { check: string }[] }
            | undefined;
        expect(verdict?.passed).toBe(false);
        expect(verdict?.issues.map((issue) => issue.check)).toContain('cites_evidence');
    });

    it('fails when there is no draft on the blackboard', async () => {
        const blackboard = createBlackboard();
        const signals: AbgSignal[] = [];
        for await (const signal of runCriticNode({ id: 'critic', kind: 'condition' }, baseContext(blackboard))) {
            signals.push(signal);
        }
        expect(collect(signals).failure?.type).toBe('failure');
    });
});

describe('runCriticNode — verification-result mode (evaluateKey present)', () => {
    type Blackboard = ReturnType<typeof createBlackboard>;

    function makeCriticNode(evaluateKey: string, outputKey?: string): AbgNodeSpec {
        const config: Record<string, unknown> = { evaluateKey };
        if (outputKey !== undefined) {
            config['outputKey'] = outputKey;
        }
        return { id: 'f1', kind: 'llm', implementation: 'critic', config };
    }

    async function runVerificationCritic(
        blackboard: Blackboard,
        evaluateKey: string,
        outputKey?: string,
    ): Promise<{ signals: readonly AbgSignal[]; verdict: CriticEvaluationVerdict | undefined }> {
        const signals: AbgSignal[] = [];
        for await (const signal of runCriticNode(makeCriticNode(evaluateKey, outputKey), baseContext(blackboard))) {
            signals.push(signal);
        }
        const success = signals.find((s): s is Extract<AbgSignal, { type: 'success' }> => s.type === 'success');
        return { signals, verdict: success?.result as CriticEvaluationVerdict | undefined };
    }

    it('outputs APPROVE when all verification results pass', async () => {
        const blackboard = createBlackboard();
        blackboard.set('test.results', [
            { passed: true, findings: ['build ok'] },
            { passed: true, findings: ['lint clean'] },
            { passed: true },
        ]);
        const { verdict } = await runVerificationCritic(blackboard, 'test.results', 'final.f3');
        expect(verdict?.verdict).toBe('APPROVE');
        expect(verdict?.checks).toHaveLength(3);
        expect(verdict?.findings).toEqual(['build ok', 'lint clean']);
        expect(blackboard.get('final.f3')).toBe('APPROVE');
        expect(blackboard.get('critic.verdict')).toBe('APPROVE');
        expect(blackboard.get('critic.passed')).toBe(true);
    });

    it('outputs REJECT when any verification result fails', async () => {
        const blackboard = createBlackboard();
        blackboard.set('test.results', [
            { passed: true },
            { passed: false, findings: ['tsc: error TS2345'] },
            { passed: true },
        ]);
        const { verdict } = await runVerificationCritic(blackboard, 'test.results', 'final.f3');
        expect(verdict?.verdict).toBe('REJECT');
        expect(verdict?.findings).toEqual(['tsc: error TS2345']);
        expect(blackboard.get('final.f3')).toBe('REJECT');
        expect(blackboard.get('critic.passed')).toBe(false);
    });

    it('accepts a bare boolean at evaluateKey', async () => {
        const blackboard = createBlackboard();
        blackboard.set('plan.goal', true);
        const { verdict } = await runVerificationCritic(blackboard, 'plan.goal', 'final.f1');
        expect(verdict?.verdict).toBe('APPROVE');
        expect(verdict?.checks).toHaveLength(1);
    });

    it('accepts a single result object at evaluateKey', async () => {
        const blackboard = createBlackboard();
        blackboard.set('code.quality', { passed: false, findings: ['circular import detected'] });
        const { verdict } = await runVerificationCritic(blackboard, 'code.quality', 'final.f4');
        expect(verdict?.verdict).toBe('REJECT');
        expect(verdict?.findings).toEqual(['circular import detected']);
    });

    it('accepts an already-aggregated verdict shape at evaluateKey', async () => {
        const blackboard = createBlackboard();
        blackboard.set('plan.constraints', { verdict: 'APPROVE', findings: [] });
        const { verdict } = await runVerificationCritic(blackboard, 'plan.constraints', 'final.f2');
        expect(verdict?.verdict).toBe('APPROVE');
    });

    it('maps a REJECT verdict shape through to REJECT', async () => {
        const blackboard = createBlackboard();
        blackboard.set('plan.constraints', { verdict: 'REJECT', findings: ['constraint X violated'] });
        const { verdict } = await runVerificationCritic(blackboard, 'plan.constraints', 'final.f2');
        expect(verdict?.verdict).toBe('REJECT');
        expect(verdict?.findings).toEqual(['constraint X violated']);
    });

    it('rejects safely when evaluateKey holds no value', async () => {
        const blackboard = createBlackboard();
        const { verdict } = await runVerificationCritic(blackboard, 'missing.key', 'final.f1');
        expect(verdict?.verdict).toBe('REJECT');
        expect(verdict?.checks[0]?.findings).toContain('no evaluation input at evaluateKey');
    });

    it('rejects an unrecognized input shape', async () => {
        const blackboard = createBlackboard();
        blackboard.set('weird.key', 42);
        const { verdict } = await runVerificationCritic(blackboard, 'weird.key', 'final.f1');
        expect(verdict?.verdict).toBe('REJECT');
        expect(verdict?.checks[0]?.findings[0]).toContain('unrecognized evaluation input shape');
    });

    it('writes to critic.verdict even without an outputKey', async () => {
        const blackboard = createBlackboard();
        blackboard.set('test.results', { passed: true });
        await runVerificationCritic(blackboard, 'test.results');
        expect(blackboard.get('critic.verdict')).toBe('APPROVE');
        expect(blackboard.has('final.f3')).toBe(false);
    });

    it('emits critic.evaluated with mode verification', async () => {
        const blackboard = createBlackboard();
        blackboard.set('test.results', { passed: true });
        const { signals } = await runVerificationCritic(blackboard, 'test.results', 'final.f3');
        const evaluated = signals.find(
            (s): s is Extract<AbgSignal, { type: 'emit' }> => s.type === 'emit' && s.event.type === 'critic.evaluated',
        );
        const payload = evaluated?.event.payload as { mode: string; verdict: string } | undefined;
        expect(payload?.mode).toBe('verification');
        expect(payload?.verdict).toBe('APPROVE');
    });
});

describe('normalizeEvaluationInput (pure unit)', () => {
    it('normalizes a bare boolean into a single check', () => {
        const results = normalizeEvaluationInput(true);
        expect(results).toHaveLength(1);
        expect(results[0]?.passed).toBe(true);
    });

    it('normalizes an array of mixed shapes', () => {
        const results = normalizeEvaluationInput([true, { passed: false, findings: ['err'] }, { verdict: 'APPROVE' }]);
        expect(results).toHaveLength(3);
        expect(results[0]?.passed).toBe(true);
        expect(results[1]?.passed).toBe(false);
        expect(results[2]?.passed).toBe(true);
    });

    it('returns a failing check for undefined', () => {
        const results = normalizeEvaluationInput(undefined);
        expect(results).toHaveLength(1);
        expect(results[0]?.passed).toBe(false);
    });

    it('returns a failing check for an empty array', () => {
        const results = normalizeEvaluationInput([]);
        expect(results).toHaveLength(1);
        expect(results[0]?.passed).toBe(false);
    });
});

describe('aggregateCriticEvaluation (pure unit)', () => {
    it('returns APPROVE when all checks pass', () => {
        const verdict = aggregateCriticEvaluation([
            { source: 'a', passed: true, findings: [] },
            { source: 'b', passed: true, findings: [] },
        ]);
        expect(verdict.verdict).toBe('APPROVE');
    });

    it('returns REJECT when any check fails and flattens findings', () => {
        const verdict = aggregateCriticEvaluation([
            { source: 'a', passed: true, findings: ['ok'] },
            { source: 'b', passed: false, findings: ['fail1', 'fail2'] },
        ]);
        expect(verdict.verdict).toBe('REJECT');
        expect(verdict.findings).toEqual(['ok', 'fail1', 'fail2']);
    });
});
