import { describe, expect, it } from 'vitest';
import { runAbgGraph } from './graph-runner';
import { createDefaultAbgNodeRegistry } from './node-registry';

const baseInput = {
    sessionId: 'session_graph_coordinator',
    now: () => '2026-06-09T00:00:00.000Z',
    modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
} as const;

describe('ABG graph coordinator composite nodes', () => {
    it('fails the graph when a selector child evaluator fails', async () => {
        const registry = createDefaultAbgNodeRegistry();
        registry.register('selector-child-failure', async function* (node, context) {
            yield { type: 'started', graphId: context.graphId, nodeId: node.id };
            yield {
                type: 'failure',
                graphId: context.graphId,
                nodeId: node.id,
                error: { code: 'condition_evaluator_failed' },
            };
        });

        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'selector-child-failure',
                entryNodeId: 'selector',
                defaults: { retryLimit: 0 },
                nodes: [
                    { id: 'selector', kind: 'selector', children: ['failed-condition'] },
                    { id: 'failed-condition', kind: 'condition', implementation: 'selector-child-failure' },
                ],
                edges: [],
                rules: [],
                policies: [],
            },
        });

        expect(result.status).toBe('failed');
        expect(
            result.events.some((event) => event.type === 'node.failed' && event.abg?.nodeId === 'failed-condition'),
        ).toBe(true);
        expect(result.events.at(-1)?.type).toBe('graph.failed');
    });

    it('completes a race when a competitor fails before a later valid winner', async () => {
        const registry = createDefaultAbgNodeRegistry();
        registry.register('race-competitor', async function* (node, context) {
            yield { type: 'started', graphId: context.graphId, nodeId: node.id };
            if (node.id === 'failed-competitor') {
                yield {
                    type: 'failure',
                    graphId: context.graphId,
                    nodeId: node.id,
                    error: { code: 'competitor_failed' },
                };
                return;
            }
            yield {
                type: 'success',
                graphId: context.graphId,
                nodeId: node.id,
                result: { valid: true },
            };
        });

        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'race-failed-competitor',
                entryNodeId: 'race',
                nodes: [
                    { id: 'race', kind: 'race', children: ['failed-competitor', 'valid-competitor'] },
                    { id: 'failed-competitor', kind: 'action', implementation: 'race-competitor' },
                    { id: 'valid-competitor', kind: 'action', implementation: 'race-competitor' },
                ],
                edges: [],
                rules: [],
                policies: [],
            },
        });

        expect(result.status).toBe('completed');
        expect(
            result.events.some((event) => event.type === 'node.failed' && event.abg?.nodeId === 'failed-competitor'),
        ).toBe(false);
        expect(
            result.events.some((event) => event.type === 'node.completed' && event.abg?.nodeId === 'valid-competitor'),
        ).toBe(true);
        expect(result.events.some((event) => event.type === 'node.completed' && event.abg?.nodeId === 'race')).toBe(
            true,
        );
        expect(result.events.at(-1)?.type).toBe('graph.completed');
    });
});
