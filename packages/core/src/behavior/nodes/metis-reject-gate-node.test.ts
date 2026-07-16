/**
 * Unit tests for deterministic metis-reject-gate runner (plan T5).
 */
import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createBlackboard } from '../../memory/blackboard';
import { PLANNER_METIS_REJECT_BUDGET } from '../planner-metis';
import { runMetisRejectGateNode } from './metis-reject-gate-node';

const NOW = '2026-07-16T12:00:00.000Z';

const GATE_NODE: AbgNodeSpec = {
    id: 'metis-reject-gate',
    kind: 'llm',
    implementation: 'metis-reject-gate',
    capabilities: [],
    config: {
        outputKey: 'metis.reject_route',
        outputEnum: ['revise', 'escalate_present'],
        rejectKey: 'metis.rejects',
        rejectBudget: PLANNER_METIS_REJECT_BUDGET,
    },
};

function baseContext(blackboard: ReturnType<typeof createBlackboard>) {
    return {
        graphId: 'planner',
        now: () => NOW,
        blackboard,
    };
}

async function collect(signals: AsyncIterable<AbgSignal>): Promise<readonly AbgSignal[]> {
    const out: AbgSignal[] = [];
    for await (const signal of signals) {
        out.push(signal);
    }
    return out;
}

describe('runMetisRejectGateNode', () => {
    it('routes revise and increments metis.rejects when rejects is 0', async () => {
        // Given
        const blackboard = createBlackboard();
        // When
        const signals = await collect(runMetisRejectGateNode(GATE_NODE, baseContext(blackboard)));
        // Then
        expect(blackboard.get('metis.reject_route')).toBe('revise');
        expect(blackboard.get('metis.rejects')).toBe(1);
        expect(signals.some((signal) => signal.type === 'success')).toBe(true);
    });

    it('routes escalate_present without incrementing when rejects is already at budget', async () => {
        // Given
        const blackboard = createBlackboard();
        blackboard.set('metis.rejects', 1);
        // When
        await collect(runMetisRejectGateNode(GATE_NODE, baseContext(blackboard)));
        // Then
        expect(blackboard.get('metis.reject_route')).toBe('escalate_present');
        expect(blackboard.get('metis.rejects')).toBe(1);
    });

    it('treats a missing metis.rejects key as 0', async () => {
        const blackboard = createBlackboard();
        await collect(runMetisRejectGateNode(GATE_NODE, baseContext(blackboard)));
        expect(blackboard.get('metis.reject_route')).toBe('revise');
        expect(blackboard.get('metis.rejects')).toBe(1);
    });

    it('fails closed when the blackboard is unavailable', async () => {
        const signals = await collect(
            runMetisRejectGateNode(GATE_NODE, {
                graphId: 'planner',
                now: () => NOW,
            }),
        );
        const failure = signals.find((signal) => signal.type === 'failure');
        expect(failure).toMatchObject({ type: 'failure', error: { code: 'memory_unavailable' } });
    });

    it('emits metis_reject_gate.evaluated with route and counter payload', async () => {
        const blackboard = createBlackboard();
        const signals = await collect(runMetisRejectGateNode(GATE_NODE, baseContext(blackboard)));
        const emit = signals.find(
            (signal) => signal.type === 'emit' && signal.event.type === 'metis_reject_gate.evaluated',
        );
        expect(emit).toBeDefined();
        if (emit?.type === 'emit') {
            expect(emit.event.payload).toEqual({
                metis_rejects: 0,
                metis_rejects_after: 1,
                reject_budget: 1,
                metis_reject_route: 'revise',
            });
        }
    });
});
