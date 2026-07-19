import type { AbgNodeSpec, AbgSignal, AgentEvent } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { runAbgGraph } from './graph-runner';
import type { AbgNodeRunContext } from './node-registry';
import { createAbgNodeRegistry } from './node-registry';

const baseInput = {
    sessionId: 'session_graph_coordinator',
    now: () => '2026-06-09T00:00:00.000Z',
    modelProviderSelection: {
        providerID: 'local',
        modelID: 'local-echo',
    },
} as const;

describe('bounded ABG graph coordinator', () => {
    it('fails abort-dominantly when the run owner aborts during provider retry sleep', async () => {
        // Given
        let nodeRuns = 0;
        let retrySleepCalls = 0;
        let retrySleepSignal: AbortSignal | undefined;
        const controller = new AbortController();
        const registry = createAbgNodeRegistry();
        registry.register(
            'rate-limit-then-success',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                nodeRuns += 1;
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                if (nodeRuns === 1) {
                    yield {
                        type: 'failure',
                        graphId: context.graphId,
                        nodeId: node.id,
                        error: {
                            code: 'provider_rate_limited',
                            message: 'temporarily overloaded',
                            retryable: true,
                            providerError: true,
                        },
                    };
                    return;
                }
                yield { type: 'success', graphId: context.graphId, nodeId: node.id };
            },
        );

        // When
        const result = await runAbgGraph({
            ...baseInput,
            registry,
            abortSignal: controller.signal,
            providerRetrySleep: async (_delayMs, signal) => {
                retrySleepCalls += 1;
                retrySleepSignal = signal;
                controller.abort();
            },
            graph: {
                id: 'abort-during-provider-wait',
                entryNodeId: 'limited',
                defaults: { retryLimit: 2 },
                nodes: [{ id: 'limited', kind: 'llm', implementation: 'rate-limit-then-success' }],
                edges: [],
                rules: [],
                policies: [],
            },
        });

        // Then
        expect(result.status).toBe('failed');
        expect(result.terminalError).toMatchObject({ code: 'provider_aborted' });
        expect(nodeRuns).toBe(1);
        expect(attemptsFor(result.events, 'limited')).toEqual([1]);
        expect(retrySleepCalls).toBe(1);
        expect(retrySleepSignal).toBe(controller.signal);
        expect(result.events.some((event) => event.type === 'graph.completed')).toBe(false);
    });
});

function attemptsFor(events: readonly AgentEvent[], nodeId: string): number[] {
    return events
        .filter((event) => event.type === 'attempt.started' && event.abg?.nodeId === nodeId)
        .map((event) => event.abg?.attempt ?? 0);
}
