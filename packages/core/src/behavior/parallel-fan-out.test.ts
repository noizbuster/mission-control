import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createBlackboard } from '../memory/blackboard.js';
import { collectSignals, createCompositeNodeTestContext } from './composite-node-test-helpers.js';
import { type AbgNodeRunContext, createDefaultAbgNodeRegistry, runAbgNode } from './node-registry.js';

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
