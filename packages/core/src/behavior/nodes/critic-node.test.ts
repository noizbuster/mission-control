import type { AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createBlackboard } from '../../memory/blackboard.js';
import { runCriticNode } from './critic-node.js';

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
