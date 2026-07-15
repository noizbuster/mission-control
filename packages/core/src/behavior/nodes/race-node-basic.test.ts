import type { AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { collectSignals, createCompositeNodeTestContext } from '../composite-node-test-helpers.js';
import { type AbgNodeRunContext, runAbgNode } from '../node-registry.js';
import { createRaceNodeRunner } from './race-node.js';
import { DONE, deferred, iterable } from './race-node-test-support.js';

function raceContext(implementation: string, children: readonly string[], runner: AbgNodeRunContext['registry']) {
    const baseContext = createCompositeNodeTestContext();
    return {
        ...baseContext,
        registry: runner ?? baseContext.registry,
        nodes: Object.fromEntries(
            children.map((childId) => [childId, { id: childId, kind: 'action' as const, implementation }]),
        ),
    } satisfies AbgNodeRunContext;
}

describe('ABG Race node', () => {
    it('chooses a valid winner and drains the losing branch', async () => {
        const pendingLoser = deferred<IteratorResult<AbgSignal>>();
        let loserNextCount = 0;
        let loserDrained = false;
        const loser = iterable({
            next: () => {
                loserNextCount += 1;
                if (loserNextCount === 1) {
                    return Promise.resolve({
                        done: false,
                        value: { type: 'started', graphId: 'graph_composite', nodeId: 'loser' },
                    });
                }
                return pendingLoser.promise;
            },
            return: () => {
                loserDrained = true;
                pendingLoser.resolve(DONE);
                return Promise.resolve(DONE);
            },
        });
        const runner = createRaceNodeRunner((childId) => {
            if (childId === 'loser') return loser;
            return (async function* winner(): AsyncIterable<AbgSignal> {
                yield { type: 'started', graphId: 'graph_composite', nodeId: 'winner' };
                yield {
                    type: 'success',
                    graphId: 'graph_composite',
                    nodeId: 'winner',
                    result: { valid: true },
                };
            })();
        });

        const settlement = collectSignals(
            runner(
                { id: 'race-valid', kind: 'race', children: ['winner', 'loser'] },
                { graphId: 'graph_composite', now: () => '2026-07-13T00:00:00.000Z' },
            ),
        );
        const signals = await settlement;

        expect(signals).toContainEqual({ type: 'started', graphId: 'graph_composite', nodeId: 'loser' });
        expect(signals.at(-1)).toMatchObject({ type: 'success', result: { winnerChild: 'winner' } });
        expect(signals).toContainEqual({
            type: 'cancelled',
            graphId: 'graph_composite',
            nodeId: 'loser',
            reason: 'race loser cancelled',
        });
        expect(loserDrained).toBe(true);
    });

    it('drains an already-completed invalid loser before settling the valid winner', async () => {
        const baseContext = createCompositeNodeTestContext();
        const invalidObserved = deferred<void>();
        const releaseWinner = deferred<void>();
        let loserDrained = false;
        baseContext.registry.register('invalid-first-race-child', async function* (node, context) {
            try {
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                if (node.id === 'winner') {
                    await releaseWinner.promise;
                    yield { type: 'success', graphId: context.graphId, nodeId: node.id, result: { valid: true } };
                    return;
                }
                invalidObserved.resolve(undefined);
                yield { type: 'success', graphId: context.graphId, nodeId: node.id, result: { valid: false } };
            } finally {
                if (node.id === 'loser') loserDrained = true;
            }
        });
        const context = raceContext('invalid-first-race-child', ['loser', 'winner'], baseContext.registry);

        const settlement = collectSignals(
            runAbgNode(
                context.registry,
                { id: 'race-completed-invalid', kind: 'race', children: ['loser', 'winner'] },
                context,
            ),
        );
        await invalidObserved.promise;
        releaseWinner.resolve(undefined);
        const signals = await settlement;

        expect(signals.at(-1)).toMatchObject({ type: 'success', result: { winnerChild: 'winner' } });
        expect(loserDrained).toBe(true);
    });

    it('drains an already-observed failed loser before settling the valid winner', async () => {
        const baseContext = createCompositeNodeTestContext();
        const failureObserved = deferred<void>();
        const releaseWinner = deferred<void>();
        let loserDrained = false;
        baseContext.registry.register('failed-first-race-child', async function* (node, context) {
            try {
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                if (node.id === 'winner') {
                    await releaseWinner.promise;
                    yield { type: 'success', graphId: context.graphId, nodeId: node.id, result: { valid: true } };
                    return;
                }
                failureObserved.resolve(undefined);
                yield {
                    type: 'failure',
                    graphId: context.graphId,
                    nodeId: node.id,
                    error: { code: 'competitor_failed' },
                };
            } finally {
                if (node.id === 'loser') loserDrained = true;
            }
        });
        const context = raceContext('failed-first-race-child', ['loser', 'winner'], baseContext.registry);

        const settlement = collectSignals(
            runAbgNode(
                context.registry,
                { id: 'race-completed-failure', kind: 'race', children: ['loser', 'winner'] },
                context,
            ),
        );
        await failureObserved.promise;
        releaseWinner.resolve(undefined);
        const signals = await settlement;

        expect(signals.at(-1)).toMatchObject({ type: 'success', result: { winnerChild: 'winner' } });
        expect(signals.some((signal) => signal.type === 'failure')).toBe(false);
        expect(loserDrained).toBe(true);
    });

    it('fails after draining branches when one competitor pump rejects before a valid winner', async () => {
        const baseContext = createCompositeNodeTestContext();
        const rejectionObserved = deferred<void>();
        const releaseWinner = deferred<void>();
        let rejectedBranchDrained = false;
        let winnerDrained = false;
        baseContext.registry.register('rejecting-race-child', async function* (node, context) {
            try {
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                if (node.id === 'winner') {
                    await releaseWinner.promise;
                    yield { type: 'success', graphId: context.graphId, nodeId: node.id, result: { valid: true } };
                    return;
                }
                rejectionObserved.resolve(undefined);
                throw new Error('race competitor failed');
            } finally {
                if (node.id === 'rejecting') rejectedBranchDrained = true;
                if (node.id === 'winner') winnerDrained = true;
            }
        });
        const context = raceContext('rejecting-race-child', ['rejecting', 'winner'], baseContext.registry);

        const settlement = collectSignals(
            runAbgNode(
                context.registry,
                { id: 'race-rejection', kind: 'race', children: ['rejecting', 'winner'] },
                context,
            ),
        );
        await rejectionObserved.promise;
        releaseWinner.resolve(undefined);
        const signals = await settlement;

        expect(signals).toContainEqual({
            type: 'failure',
            graphId: 'graph_composite',
            nodeId: 'rejecting',
            error: { code: 'race_child_pump_failed', message: 'race competitor failed' },
        });
        expect(signals.at(-1)).toMatchObject({
            type: 'failure',
            nodeId: 'race-rejection',
            error: {
                code: 'race_cleanup_failed',
                failures: [{ code: 'race_child_pump_failed', childId: 'rejecting', message: 'race competitor failed' }],
            },
        });
        expect(signals.some((signal) => signal.type === 'success' && signal.nodeId === 'race-rejection')).toBe(false);
        expect(rejectedBranchDrained).toBe(true);
        expect(winnerDrained).toBe(true);
    });

    it('fails when no competitor produces a valid success', async () => {
        const baseContext = createCompositeNodeTestContext();
        baseContext.registry.register('invalid-race-child', async function* (node, context) {
            const success: AbgSignal = {
                type: 'success',
                graphId: context.graphId,
                nodeId: node.id,
                result: { valid: false },
            };
            yield { type: 'started', graphId: context.graphId, nodeId: node.id };
            yield success;
        });
        const context = {
            ...baseContext,
            nodes: {
                ...baseContext.nodes,
                invalid: { id: 'invalid', kind: 'action', implementation: 'invalid-race-child' },
            },
        } satisfies AbgNodeRunContext;

        const signals = await collectSignals(
            runAbgNode(
                context.registry,
                { id: 'race-no-winner', kind: 'race', children: ['invalid', 'failingApproval'] },
                context,
            ),
        );

        expect(signals.at(-1)).toMatchObject({
            type: 'failure',
            nodeId: 'race-no-winner',
            error: { code: 'race_no_valid_success' },
        });
        expect(signals.some((signal) => signal.type === 'success' && signal.nodeId === 'race-no-winner')).toBe(false);
    });
});
