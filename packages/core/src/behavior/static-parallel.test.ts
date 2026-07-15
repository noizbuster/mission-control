import { describe, expect, it } from 'vitest';
import { collectSignals, createCompositeNodeTestContext } from './composite-node-test-helpers';
import { type AbgNodeRunContext, type AbgNodeRunner, runAbgNode } from './node-registry';

const CHILD_IDS: readonly string[] = ['child-0', 'child-1', 'child-2', 'child-3', 'child-4'];

function createStaticParallelContext(runner: AbgNodeRunner): AbgNodeRunContext & {
    readonly registry: NonNullable<AbgNodeRunContext['registry']>;
} {
    const baseContext = createCompositeNodeTestContext();
    baseContext.registry.register('tracked-static-child', runner);
    const nodes = { ...baseContext.nodes };
    for (const childId of CHILD_IDS) {
        nodes[childId] = {
            id: childId,
            kind: 'action',
            implementation: 'tracked-static-child',
        };
    }
    return { ...baseContext, nodes };
}

describe('ABG static parallel node', () => {
    it('defaults to two overlapping children for a five-child parallel node', async () => {
        let active = 0;
        let peak = 0;
        const runContext = createStaticParallelContext(async function* (node, context) {
            active += 1;
            peak = Math.max(peak, active);
            await Promise.resolve();
            active -= 1;
            yield { type: 'success', graphId: context.graphId, nodeId: node.id };
        });

        await collectSignals(
            runAbgNode(
                runContext.registry,
                { id: 'parallel-default', kind: 'parallel', children: [...CHILD_IDS] },
                runContext,
            ),
        );

        expect(peak).toBe(2);
    });

    it('honors an explicit concurrency of three for five static children', async () => {
        let active = 0;
        let peak = 0;
        const runContext = createStaticParallelContext(async function* (node, context) {
            active += 1;
            peak = Math.max(peak, active);
            await Promise.resolve();
            active -= 1;
            yield { type: 'success', graphId: context.graphId, nodeId: node.id };
        });

        await collectSignals(
            runAbgNode(
                runContext.registry,
                {
                    id: 'parallel-three',
                    kind: 'parallel',
                    children: [...CHILD_IDS],
                    config: { concurrency: 3 },
                },
                runContext,
            ),
        );

        expect(peak).toBe(3);
    });

    it('aggregates child signals and results in declaration order', async () => {
        const runContext = createStaticParallelContext(async function* (node, context) {
            const reverseIndex = CHILD_IDS.length - CHILD_IDS.indexOf(node.id) - 1;
            for (let turn = 0; turn < reverseIndex; turn += 1) {
                await Promise.resolve();
            }
            yield {
                type: 'success',
                graphId: context.graphId,
                nodeId: node.id,
                result: { childId: node.id },
            };
        });

        const signals = await collectSignals(
            runAbgNode(
                runContext.registry,
                { id: 'parallel-order', kind: 'parallel', children: [...CHILD_IDS] },
                runContext,
            ),
        );

        expect(
            signals
                .filter((signal) => signal.type === 'success' && signal.nodeId !== 'parallel-order')
                .map((signal) => signal.nodeId),
        ).toEqual(CHILD_IDS);
        expect(signals.at(-1)).toMatchObject({
            type: 'success',
            result: { completedChildren: CHILD_IDS },
        });
    });

    it('converts a child iterator rejection into a fail-closed parent result', async () => {
        const runContext = createStaticParallelContext(async function* (node, context) {
            if (node.id === 'child-2') {
                throw new Error('child iterator rejected');
            }
            yield { type: 'success', graphId: context.graphId, nodeId: node.id };
        });

        const signals = await collectSignals(
            runAbgNode(
                runContext.registry,
                { id: 'parallel-rejection', kind: 'parallel', children: [...CHILD_IDS] },
                runContext,
            ),
        );

        expect(signals).toContainEqual({
            type: 'failure',
            graphId: 'graph_composite',
            nodeId: 'child-2',
            error: {
                code: 'parallel_child_threw',
                childId: 'child-2',
                message: 'child iterator rejected',
            },
        });
        expect(signals.at(-1)).toMatchObject({
            type: 'failure',
            nodeId: 'parallel-rejection',
            error: {
                code: 'parallel_child_failed',
                failedChildren: ['child-2'],
            },
        });
    });

    it('completes any-success mode when at least one child succeeds', async () => {
        const context = createCompositeNodeTestContext();

        const signals = await collectSignals(
            runAbgNode(
                context.registry,
                {
                    id: 'parallel-one',
                    kind: 'parallel',
                    children: ['failingApproval', 'memory'],
                    config: { completion: ['a', 'ny-success'].join('') },
                },
                context,
            ),
        );

        expect(signals.at(-1)).toMatchObject({
            type: 'success',
            result: { completedChildren: ['memory'], failedChildren: ['failingApproval'] },
        });
    });
});
