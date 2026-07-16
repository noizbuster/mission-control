/**
 * Unit tests for deterministic dual-review-route runner (plan T6).
 */
import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createBlackboard } from '../../memory/blackboard';
import { runDualReviewRouteNode } from './dual-review-route-node';

const NOW = '2026-07-16T12:00:00.000Z';

const ROUTE_NODE: AbgNodeSpec = {
    id: 'dual-review-route',
    kind: 'llm',
    implementation: 'dual-review-route',
    capabilities: [],
    config: {
        outputKey: 'dual.route',
        outputEnum: ['skip', 'run'],
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

describe('runDualReviewRouteNode', () => {
    it('routes skip when intent=clear and review_required=false', async () => {
        // Given
        const blackboard = createBlackboard();
        blackboard.set('intent', 'clear');
        blackboard.set('review_required', false);
        // When
        const signals = await collect(runDualReviewRouteNode(ROUTE_NODE, baseContext(blackboard)));
        // Then
        expect(blackboard.get('dual.route')).toBe('skip');
        expect(signals.some((signal) => signal.type === 'success')).toBe(true);
    });

    it('routes run when review_required is true', async () => {
        const blackboard = createBlackboard();
        blackboard.set('intent', 'clear');
        blackboard.set('review_required', true);
        await collect(runDualReviewRouteNode(ROUTE_NODE, baseContext(blackboard)));
        expect(blackboard.get('dual.route')).toBe('run');
    });

    it('routes run when intent is unclear', async () => {
        const blackboard = createBlackboard();
        blackboard.set('intent', 'unclear');
        blackboard.set('review_required', false);
        await collect(runDualReviewRouteNode(ROUTE_NODE, baseContext(blackboard)));
        expect(blackboard.get('dual.route')).toBe('run');
    });

    it('fail-closes to run when keys are missing', async () => {
        const blackboard = createBlackboard();
        await collect(runDualReviewRouteNode(ROUTE_NODE, baseContext(blackboard)));
        expect(blackboard.get('dual.route')).toBe('run');
    });

    it('derives intent from ambiguity.classification when intent key is absent', async () => {
        const blackboard = createBlackboard();
        blackboard.set('ambiguity.classification', 'clear');
        blackboard.set('review_required', false);
        await collect(runDualReviewRouteNode(ROUTE_NODE, baseContext(blackboard)));
        expect(blackboard.get('dual.route')).toBe('skip');
        expect(blackboard.get('intent')).toBe('clear');
    });

    it('fails closed when the blackboard is unavailable', async () => {
        const signals = await collect(
            runDualReviewRouteNode(ROUTE_NODE, {
                graphId: 'planner',
                now: () => NOW,
            }),
        );
        const failure = signals.find((signal) => signal.type === 'failure');
        expect(failure).toMatchObject({ type: 'failure', error: { code: 'memory_unavailable' } });
    });

    it('emits dual_review_route.evaluated with route payload', async () => {
        const blackboard = createBlackboard();
        blackboard.set('intent', 'clear');
        blackboard.set('review_required', false);
        const signals = await collect(runDualReviewRouteNode(ROUTE_NODE, baseContext(blackboard)));
        const emit = signals.find(
            (signal) => signal.type === 'emit' && signal.event.type === 'dual_review_route.evaluated',
        );
        expect(emit).toBeDefined();
        if (emit?.type === 'emit') {
            expect(emit.event.payload).toEqual({
                intent: 'clear',
                review_required: false,
                dual_route: 'skip',
            });
        }
    });
});
