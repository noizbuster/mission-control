import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createBlackboard } from '../memory/blackboard.js';
import { collectSignals, createCompositeNodeTestContext as context } from './composite-node-test-helpers.js';
import { type AbgNodeRunContext, createDefaultAbgNodeRegistry, runAbgNode } from './node-registry.js';

function blackboardContext() {
    const helper = context();
    const blackboard = createBlackboard();
    return { ...helper, blackboard };
}

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

describe('ABG parallel node fanOutKey', () => {
    it('fans out one child run per blackboard array item and aggregates in order', async () => {
        const ctx = blackboardContext();
        ctx.blackboard.set('plan.todos', ['task-a', 'task-b', 'task-c']);
        const node: AbgNodeSpec = {
            id: 'delegate-wave',
            kind: 'parallel',
            children: ['memory'],
            config: { fanOutKey: 'plan.todos', completionKey: 'delegate.complete' },
        };
        const signals = await collectSignals(runAbgNode(ctx.registry, node, ctx));

        expect(signals.at(-1)).toMatchObject({
            type: 'success',
            result: { completedChildren: expect.arrayContaining(['memory:0', 'memory:1', 'memory:2']) },
        });
        expect(ctx.blackboard.get('delegate.complete')).toBe(true);
        expect(ctx.blackboard.get('delegate.results')).toMatchObject([
            { item: 'task-a', index: 0, failed: false },
            { item: 'task-b', index: 1, failed: false },
            { item: 'task-c', index: 2, failed: false },
        ]);
    });

    it('aggregates into a configured aggregateKey instead of the default', async () => {
        const ctx = blackboardContext();
        ctx.blackboard.set('wave.tasks', ['one', 'two']);
        const node: AbgNodeSpec = {
            id: 'delegate-wave',
            kind: 'parallel',
            children: ['memory'],
            config: {
                fanOutKey: 'wave.tasks',
                aggregateKey: 'wave.results',
                completionKey: 'wave.complete',
            },
        };
        await collectSignals(runAbgNode(ctx.registry, node, ctx));

        expect(ctx.blackboard.has('delegate.results')).toBe(false);
        expect(ctx.blackboard.get('wave.results')).toMatchObject([
            { item: 'one', index: 0 },
            { item: 'two', index: 1 },
        ]);
        expect(ctx.blackboard.get('wave.complete')).toBe(true);
    });

    it('fails the parent when a required child fails and leaves completionKey unset', async () => {
        const ctx = blackboardContext();
        ctx.blackboard.set('plan.todos', ['a', 'b', 'c']);
        const node: AbgNodeSpec = {
            id: 'delegate-wave',
            kind: 'parallel',
            children: ['failingCondition'],
            config: { fanOutKey: 'plan.todos', completionKey: 'delegate.complete' },
        };
        const signals = await collectSignals(runAbgNode(ctx.registry, node, ctx));

        expect(signals.at(-1)).toMatchObject({
            type: 'failure',
            error: { code: 'parallel_fanout_child_failed' },
        });
        expect(ctx.blackboard.has('delegate.complete')).toBe(false);
    });

    it('continueOnFailure records failed children and still completes', async () => {
        const ctx = blackboardContext();
        ctx.blackboard.set('plan.todos', ['a', 'b']);
        const node: AbgNodeSpec = {
            id: 'delegate-wave',
            kind: 'parallel',
            children: ['failingCondition'],
            config: {
                fanOutKey: 'plan.todos',
                completionKey: 'delegate.complete',
                continueOnFailure: true,
            },
        };
        const signals = await collectSignals(runAbgNode(ctx.registry, node, ctx));

        expect(signals.at(-1)).toMatchObject({
            type: 'success',
            result: {
                completedChildren: [],
                failedChildren: ['failingCondition:0', 'failingCondition:1'],
            },
        });
        expect(ctx.blackboard.get('delegate.complete')).toBe(true);
    });

    it('empty array succeeds with an empty aggregate and sets the completionKey', async () => {
        const ctx = blackboardContext();
        ctx.blackboard.set('plan.todos', []);
        const node: AbgNodeSpec = {
            id: 'delegate-wave',
            kind: 'parallel',
            children: ['memory'],
            config: { fanOutKey: 'plan.todos', completionKey: 'delegate.complete' },
        };
        const signals = await collectSignals(runAbgNode(ctx.registry, node, ctx));

        expect(signals.at(-1)).toMatchObject({ type: 'success', result: { itemCount: 0 } });
        expect(ctx.blackboard.get('delegate.results')).toEqual([]);
        expect(ctx.blackboard.get('delegate.complete')).toBe(true);
    });

    it('fails closed when the blackboard key is missing', async () => {
        const ctx = blackboardContext();
        const node: AbgNodeSpec = {
            id: 'delegate-wave',
            kind: 'parallel',
            children: ['memory'],
            config: { fanOutKey: 'plan.todos', completionKey: 'delegate.complete' },
        };
        const signals = await collectSignals(runAbgNode(ctx.registry, node, ctx));

        expect(signals.at(-1)).toMatchObject({
            type: 'failure',
            error: { code: 'parallel_fanout_key_not_array' },
        });
        expect(ctx.blackboard.has('delegate.complete')).toBe(false);
    });

    it('fails closed when the blackboard value is not an array', async () => {
        const ctx = blackboardContext();
        ctx.blackboard.set('plan.todos', 'not-an-array');
        const node: AbgNodeSpec = {
            id: 'delegate-wave',
            kind: 'parallel',
            children: ['memory'],
            config: { fanOutKey: 'plan.todos' },
        };
        const signals = await collectSignals(runAbgNode(ctx.registry, node, ctx));

        expect(signals.at(-1)).toMatchObject({
            type: 'failure',
            error: { code: 'parallel_fanout_key_not_array' },
        });
    });

    it('bounds concurrency to the configured limit', async () => {
        const registry = createDefaultAbgNodeRegistry();
        let active = 0;
        let peak = 0;
        registry.register('tracking', async function* trackingNode(node, runCtx) {
            active += 1;
            peak = Math.max(peak, active);
            await Promise.resolve();
            active -= 1;
            const startedSignal: AbgSignal = { type: 'started', graphId: runCtx.graphId, nodeId: node.id };
            const successSignal: AbgSignal = { type: 'success', graphId: runCtx.graphId, nodeId: node.id };
            yield startedSignal;
            yield successSignal;
        });
        const ctx: AbgNodeRunContext = {
            graphId: 'graph_composite',
            now: () => '2026-06-03T10:00:00.000Z',
            registry,
            nodes: { trackingChild: { id: 'trackingChild', kind: 'memory', implementation: 'tracking' } },
            blackboard: createBlackboard(),
        };
        ctx.blackboard?.set('items', ['a', 'b', 'c']);
        const node: AbgNodeSpec = {
            id: 'wave',
            kind: 'parallel',
            children: ['trackingChild'],
            config: { fanOutKey: 'items', concurrency: 2 },
        };
        await collectSignals(runAbgNode(registry, node, ctx));

        expect(peak).toBe(2);
    });
});
