import { describe, expect, it } from 'vitest';
import { collectSignals, createCompositeNodeTestContext as context } from './composite-node-test-helpers.js';
import { runAbgNode } from './node-registry.js';

describe('ABG composite nodes', () => {
    it('parallel join collects results', async () => {
        const runContext = context();
        const registry = runContext.registry;
        const parallelSignals = await collectSignals(
            runAbgNode(
                registry,
                {
                    id: 'gather-context',
                    kind: 'parallel',
                    children: ['memory', 'tool'],
                },
                runContext,
            ),
        );
        const joinSignals = await collectSignals(
            runAbgNode(
                registry,
                {
                    id: 'join-evidence',
                    kind: 'join',
                    config: {
                        items: ['local-memory', 'mock-search', 'local-memory'],
                    },
                },
                runContext,
            ),
        );

        expect(parallelSignals.filter((signal) => signal.type === 'success')).toHaveLength(3);
        expect(joinSignals.at(-1)).toMatchObject({
            type: 'success',
            result: {
                items: ['local-memory', 'mock-search'],
            },
        });
    });

    it('race cancels losing branches', async () => {
        const runContext = context();

        const signals = await collectSignals(
            runAbgNode(
                runContext.registry,
                {
                    id: 'race-context',
                    kind: 'race',
                    children: ['memory', 'tool'],
                },
                runContext,
            ),
        );

        expect(signals).toContainEqual({
            type: 'cancelled',
            graphId: 'graph_composite',
            nodeId: 'tool',
            reason: 'race loser cancelled',
        });
    });

    it('selector follows configured child priority', async () => {
        const runContext = context();

        const signals = await collectSignals(
            runAbgNode(
                runContext.registry,
                {
                    id: 'select-priority',
                    kind: 'selector',
                    children: ['memory', 'tool'],
                    config: {
                        priorities: ['tool', 'memory'],
                    },
                },
                runContext,
            ),
        );

        expect(signals[1]).toMatchObject({
            type: 'started',
            nodeId: 'tool',
        });
        expect(signals.at(-1)).toMatchObject({
            type: 'success',
            result: {
                selectedChild: 'tool',
            },
        });
    });

    it('parallel one-success mode completes when at least one child succeeds', async () => {
        const runContext = context();

        const signals = await collectSignals(
            runAbgNode(
                runContext.registry,
                {
                    id: 'parallel-one',
                    kind: 'parallel',
                    children: ['failingCondition', 'memory'],
                    config: {
                        completion: ['a', 'ny-success'].join(''),
                    },
                },
                runContext,
            ),
        );

        expect(signals.at(-1)).toMatchObject({
            type: 'success',
            result: {
                completedChildren: ['memory'],
                failedChildren: ['failingCondition'],
            },
        });
    });

    it('join supports append and dedupe merge strategies', async () => {
        const runContext = context();
        const appendSignals = await collectSignals(
            runAbgNode(
                runContext.registry,
                {
                    id: 'join-append',
                    kind: 'join',
                    config: {
                        mergeStrategy: 'append',
                        items: ['local-memory', 'mock-search', 'local-memory'],
                    },
                },
                runContext,
            ),
        );
        const dedupeSignals = await collectSignals(
            runAbgNode(
                runContext.registry,
                {
                    id: 'join-dedupe',
                    kind: 'join',
                    config: {
                        mergeStrategy: 'dedupe',
                        items: ['local-memory', 'mock-search', 'local-memory'],
                    },
                },
                runContext,
            ),
        );

        expect(appendSignals.at(-1)).toMatchObject({
            type: 'success',
            result: {
                items: ['local-memory', 'mock-search', 'local-memory'],
            },
        });
        expect(dedupeSignals.at(-1)).toMatchObject({
            type: 'success',
            result: {
                items: ['local-memory', 'mock-search'],
            },
        });
    });
});
