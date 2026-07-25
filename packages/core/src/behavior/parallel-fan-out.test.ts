import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createBlackboard } from '../memory/blackboard';
import { collectSignals, createCompositeNodeTestContext } from './composite-node-test-helpers';
import { type AbgNodeRunContext, createDefaultAbgNodeRegistry, runAbgNode } from './node-registry';
import { collectStaticParallelOutcomes } from './nodes/parallel-static';

function fanOutContext() {
    return { ...createCompositeNodeTestContext(), blackboard: createBlackboard() };
}

describe('ABG parallel node fanOutKey', () => {
    it('fans out one child run per blackboard array item and aggregates in order', async () => {
        const context = fanOutContext();
        context.blackboard.set('plan.todos', ['task-a', 'task-b', 'task-c']);
        const node: AbgNodeSpec = {
            id: 'delegate-wave',
            kind: 'parallel',
            children: ['memory'],
            config: { fanOutKey: 'plan.todos', completionKey: 'delegate.complete' },
        };
        const signals = await collectSignals(runAbgNode(context.registry, node, context));

        expect(signals.at(-1)).toMatchObject({
            type: 'success',
            result: { completedChildren: expect.arrayContaining(['memory:0', 'memory:1', 'memory:2']) },
        });
        expect(context.blackboard.get('delegate.complete')).toBe(true);
        expect(context.blackboard.get('delegate.results')).toMatchObject([
            { item: 'task-a', index: 0, failed: false },
            { item: 'task-b', index: 1, failed: false },
            { item: 'task-c', index: 2, failed: false },
        ]);
    });

    it('aggregates into a configured aggregateKey instead of the default', async () => {
        const context = fanOutContext();
        context.blackboard.set('wave.tasks', ['one', 'two']);
        const node: AbgNodeSpec = {
            id: 'delegate-wave',
            kind: 'parallel',
            children: ['memory'],
            config: { fanOutKey: 'wave.tasks', aggregateKey: 'wave.results', completionKey: 'wave.complete' },
        };
        await collectSignals(runAbgNode(context.registry, node, context));

        expect(context.blackboard.has('delegate.results')).toBe(false);
        expect(context.blackboard.get('wave.results')).toMatchObject([
            { item: 'one', index: 0 },
            { item: 'two', index: 1 },
        ]);
        expect(context.blackboard.get('wave.complete')).toBe(true);
    });

    it('fails the parent when a required child fails and leaves completionKey unset', async () => {
        const context = fanOutContext();
        context.blackboard.set('plan.todos', ['a', 'b', 'c']);
        const node: AbgNodeSpec = {
            id: 'delegate-wave',
            kind: 'parallel',
            children: ['failingApproval'],
            config: { fanOutKey: 'plan.todos', completionKey: 'delegate.complete' },
        };
        const signals = await collectSignals(runAbgNode(context.registry, node, context));

        expect(signals.at(-1)).toMatchObject({ type: 'failure', error: { code: 'parallel_fanout_child_failed' } });
        expect(context.blackboard.has('delegate.complete')).toBe(false);
    });

    it('continueOnFailure records failed children and still completes', async () => {
        const context = fanOutContext();
        context.blackboard.set('plan.todos', ['a', 'b']);
        const node: AbgNodeSpec = {
            id: 'delegate-wave',
            kind: 'parallel',
            children: ['failingApproval'],
            config: { fanOutKey: 'plan.todos', completionKey: 'delegate.complete', continueOnFailure: true },
        };
        const signals = await collectSignals(runAbgNode(context.registry, node, context));

        expect(signals.at(-1)).toMatchObject({
            type: 'success',
            result: { completedChildren: [], failedChildren: ['failingApproval:0', 'failingApproval:1'] },
        });
        expect(context.blackboard.get('delegate.complete')).toBe(true);
    });

    it('empty array succeeds with an empty aggregate and sets the completionKey', async () => {
        const context = fanOutContext();
        context.blackboard.set('plan.todos', []);
        const node: AbgNodeSpec = {
            id: 'delegate-wave',
            kind: 'parallel',
            children: ['memory'],
            config: { fanOutKey: 'plan.todos', completionKey: 'delegate.complete' },
        };
        const signals = await collectSignals(runAbgNode(context.registry, node, context));

        expect(signals.at(-1)).toMatchObject({ type: 'success', result: { itemCount: 0 } });
        expect(context.blackboard.get('delegate.results')).toEqual([]);
        expect(context.blackboard.get('delegate.complete')).toBe(true);
    });

    it('fails closed when the blackboard key is missing', async () => {
        const context = fanOutContext();
        const node: AbgNodeSpec = {
            id: 'delegate-wave',
            kind: 'parallel',
            children: ['memory'],
            config: { fanOutKey: 'plan.todos', completionKey: 'delegate.complete' },
        };
        const signals = await collectSignals(runAbgNode(context.registry, node, context));

        expect(signals.at(-1)).toMatchObject({ type: 'failure', error: { code: 'parallel_fanout_key_not_array' } });
        expect(context.blackboard.has('delegate.complete')).toBe(false);
    });

    it('fails closed when the blackboard value is not an array', async () => {
        const context = fanOutContext();
        context.blackboard.set('plan.todos', 'not-an-array');
        const node: AbgNodeSpec = {
            id: 'delegate-wave',
            kind: 'parallel',
            children: ['memory'],
            config: { fanOutKey: 'plan.todos' },
        };
        const signals = await collectSignals(runAbgNode(context.registry, node, context));

        expect(signals.at(-1)).toMatchObject({ type: 'failure', error: { code: 'parallel_fanout_key_not_array' } });
    });

    it('bounds concurrency to the configured limit', async () => {
        const registry = createDefaultAbgNodeRegistry();
        let active = 0;
        let peak = 0;
        registry.register('tracking', async function* trackingNode(node, runContext) {
            active += 1;
            peak = Math.max(peak, active);
            await Promise.resolve();
            active -= 1;
            const startedSignal: AbgSignal = { type: 'started', graphId: runContext.graphId, nodeId: node.id };
            const successSignal: AbgSignal = { type: 'success', graphId: runContext.graphId, nodeId: node.id };
            yield startedSignal;
            yield successSignal;
        });
        const context: AbgNodeRunContext = {
            graphId: 'graph_composite',
            now: () => '2026-06-03T10:00:00.000Z',
            registry,
            nodes: { trackingChild: { id: 'trackingChild', kind: 'memory', implementation: 'tracking' } },
            blackboard: createBlackboard(),
        };
        context.blackboard?.set('items', ['a', 'b', 'c']);
        const node: AbgNodeSpec = {
            id: 'wave',
            kind: 'parallel',
            children: ['trackingChild'],
            config: { fanOutKey: 'items', concurrency: 2 },
        };
        await collectSignals(runAbgNode(registry, node, context));

        expect(peak).toBe(2);
    });
});

describe('ABG parallel node fanOutKey abort and fail-fast', () => {
    it('stops without launching a wave when the run-owner abort signal is already set', async () => {
        const registry = createDefaultAbgNodeRegistry();
        let runs = 0;
        registry.register('tracking', async function* trackingNode(node, runContext) {
            runs += 1;
            yield { type: 'started', graphId: runContext.graphId, nodeId: node.id };
            yield { type: 'success', graphId: runContext.graphId, nodeId: node.id };
        });
        const controller = new AbortController();
        controller.abort();
        const context: AbgNodeRunContext = {
            graphId: 'graph_composite',
            now: () => '2026-06-03T10:00:00.000Z',
            registry,
            nodes: { trackingChild: { id: 'trackingChild', kind: 'memory', implementation: 'tracking' } },
            blackboard: createBlackboard(),
            abortSignal: controller.signal,
        };
        context.blackboard?.set('plan.todos', ['a', 'b', 'c', 'd']);
        const node: AbgNodeSpec = {
            id: 'delegate-wave',
            kind: 'parallel',
            children: ['trackingChild'],
            config: { fanOutKey: 'plan.todos', concurrency: 2 },
        };
        const signals = await collectSignals(runAbgNode(registry, node, context));

        expect(runs).toBe(0);
        expect(signals.at(-1)).toMatchObject({ type: 'failure', error: { code: 'parallel_fanout_aborted' } });
    });

    it('stops launching later waves when the abort signal fires during the first wave', async () => {
        const registry = createDefaultAbgNodeRegistry();
        let runs = 0;
        const controller = new AbortController();
        registry.register('tracking', async function* trackingNode(node, runContext) {
            runs += 1;
            // Abort as soon as the first wave of children starts. The wave-top gate must
            // prevent the remaining waves from launching instead of fast-failing each one.
            controller.abort();
            yield { type: 'started', graphId: runContext.graphId, nodeId: node.id };
            yield { type: 'success', graphId: runContext.graphId, nodeId: node.id };
        });
        const context: AbgNodeRunContext = {
            graphId: 'graph_composite',
            now: () => '2026-06-03T10:00:00.000Z',
            registry,
            nodes: { trackingChild: { id: 'trackingChild', kind: 'memory', implementation: 'tracking' } },
            blackboard: createBlackboard(),
            abortSignal: controller.signal,
        };
        // 6 items, concurrency 2 => 3 waves. Only the first wave (2 children) may run.
        context.blackboard?.set('plan.todos', ['a', 'b', 'c', 'd', 'e', 'f']);
        const node: AbgNodeSpec = {
            id: 'delegate-wave',
            kind: 'parallel',
            children: ['trackingChild'],
            config: { fanOutKey: 'plan.todos', concurrency: 2 },
        };
        const signals = await collectSignals(runAbgNode(registry, node, context));

        expect(runs).toBe(2);
        expect(signals.at(-1)).toMatchObject({ type: 'failure', error: { code: 'parallel_fanout_aborted' } });
    });

    it('fail-stops scheduling later waves after a required child fails (concurrency 1)', async () => {
        const registry = createDefaultAbgNodeRegistry();
        let runs = 0;
        registry.register('alwaysFail', async function* failingNode(node, runContext) {
            runs += 1;
            yield { type: 'started', graphId: runContext.graphId, nodeId: node.id };
            yield {
                type: 'failure',
                graphId: runContext.graphId,
                nodeId: node.id,
                error: { code: 'child_failed', message: 'always fails' },
            };
        });
        const context: AbgNodeRunContext = {
            graphId: 'graph_composite',
            now: () => '2026-06-03T10:00:00.000Z',
            registry,
            nodes: { failChild: { id: 'failChild', kind: 'memory', implementation: 'alwaysFail' } },
            blackboard: createBlackboard(),
        };
        context.blackboard?.set('plan.todos', ['a', 'b', 'c', 'd']);
        const node: AbgNodeSpec = {
            id: 'delegate-wave',
            kind: 'parallel',
            children: ['failChild'],
            config: { fanOutKey: 'plan.todos', concurrency: 1 },
        };
        const signals = await collectSignals(runAbgNode(registry, node, context));

        // Without fail-fast every item would run (runs === 4); the fix stops after the first.
        expect(runs).toBe(1);
        expect(signals.at(-1)).toMatchObject({ type: 'failure', error: { code: 'parallel_fanout_child_failed' } });
    });

    it('still runs every wave after a child fails when continueOnFailure is set', async () => {
        const registry = createDefaultAbgNodeRegistry();
        let runs = 0;
        registry.register('alwaysFail', async function* failingNode(node, runContext) {
            runs += 1;
            yield { type: 'started', graphId: runContext.graphId, nodeId: node.id };
            yield {
                type: 'failure',
                graphId: runContext.graphId,
                nodeId: node.id,
                error: { code: 'child_failed', message: 'always fails' },
            };
        });
        const context: AbgNodeRunContext = {
            graphId: 'graph_composite',
            now: () => '2026-06-03T10:00:00.000Z',
            registry,
            nodes: { failChild: { id: 'failChild', kind: 'memory', implementation: 'alwaysFail' } },
            blackboard: createBlackboard(),
        };
        context.blackboard?.set('plan.todos', ['a', 'b', 'c', 'd']);
        const node: AbgNodeSpec = {
            id: 'delegate-wave',
            kind: 'parallel',
            children: ['failChild'],
            config: { fanOutKey: 'plan.todos', concurrency: 1, continueOnFailure: true },
        };
        const signals = await collectSignals(runAbgNode(registry, node, context));

        expect(runs).toBe(4);
        expect(signals.at(-1)).toMatchObject({ type: 'success' });
    });
});

describe('ABG parallel node static children abort', () => {
    it('stops launching later waves when the abort signal fires during a wave', async () => {
        const registry = createDefaultAbgNodeRegistry();
        let runs = 0;
        const controller = new AbortController();
        registry.register('tracking', async function* trackingNode(node, runContext) {
            runs += 1;
            controller.abort();
            yield { type: 'started', graphId: runContext.graphId, nodeId: node.id };
            yield { type: 'success', graphId: runContext.graphId, nodeId: node.id };
        });
        const context: AbgNodeRunContext = {
            graphId: 'graph_composite',
            now: () => '2026-06-03T10:00:00.000Z',
            registry,
            nodes: {
                a: { id: 'a', kind: 'memory', implementation: 'tracking' },
                b: { id: 'b', kind: 'memory', implementation: 'tracking' },
                c: { id: 'c', kind: 'memory', implementation: 'tracking' },
                d: { id: 'd', kind: 'memory', implementation: 'tracking' },
            },
            blackboard: createBlackboard(),
            abortSignal: controller.signal,
        };
        const node: AbgNodeSpec = {
            id: 'wave',
            kind: 'parallel',
            children: ['a', 'b', 'c', 'd'],
            config: { concurrency: 2 },
        };
        await collectSignals(runAbgNode(registry, node, context));

        // First wave (a, b) runs and raises the abort; waves for c, d must not launch.
        expect(runs).toBe(2);
    });

    it('does not launch a wave when collectStaticParallelOutcomes is called with an already-aborted signal', async () => {
        const registry = createDefaultAbgNodeRegistry();
        let runs = 0;
        registry.register('tracking', async function* trackingNode(node, runContext) {
            runs += 1;
            yield { type: 'success', graphId: runContext.graphId, nodeId: node.id };
        });
        const controller = new AbortController();
        controller.abort();
        const context: AbgNodeRunContext = {
            graphId: 'graph_composite',
            now: () => '2026-06-03T10:00:00.000Z',
            registry,
            nodes: { a: { id: 'a', kind: 'memory', implementation: 'tracking' } },
            blackboard: createBlackboard(),
            abortSignal: controller.signal,
        };
        const node: AbgNodeSpec = { id: 'wave', kind: 'parallel', children: ['a'] };
        await collectStaticParallelOutcomes(node, context, (childId, runContext) =>
            runAbgNode(
                runContext.registry ?? registry,
                { id: childId, kind: 'memory', implementation: 'tracking' },
                runContext,
            ),
        );

        expect(runs).toBe(0);
    });
});
