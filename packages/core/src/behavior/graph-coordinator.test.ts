import type { AbgNodeSpec, AbgSignal, AgentEvent } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createAbgEmitSignal } from './abg-emit.js';
import { runAbgGraph } from './graph-runner.js';
import { deriveAbgGraphSnapshot } from './graph-state.js';
import type { AbgNodeRunContext } from './node-registry.js';
import { createAbgNodeRegistry } from './node-registry.js';

const baseInput = {
    sessionId: 'session_graph_coordinator',
    now: () => '2026-06-09T00:00:00.000Z',
    modelProviderSelection: {
        providerID: 'local',
        modelID: 'local-echo',
    },
} as const;

describe('bounded ABG graph coordinator', () => {
    it('runs a linear graph through the authorable graph adapter', async () => {
        // Given
        const result = await runAbgGraph({
            ...baseInput,
            graph: linearGraph(),
        });

        // Then
        expect(result.status).toBe('completed');
        expect(result.events.map((event) => event.type)).toEqual(
            expect.arrayContaining([
                'graph.started',
                'attempt.started',
                'node.started',
                'node.completed',
                'attempt.completed',
                'graph.completed',
            ]),
        );
        expect(result.events.find((event) => event.type === 'attempt.started')?.durability).toBe('durable');
        expect(result.events.find((event) => event.type === 'node.started')?.abg?.nodeKind).toBe('action');
    });

    it('retries a failed node attempt and completes when the retry succeeds', async () => {
        // Given
        const registry = createAbgNodeRegistry();
        registry.register('fail-once', failTimesBeforeSuccess(1));

        // When
        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'retry-success',
                entryNodeId: 'flaky',
                defaults: { retryLimit: 2 },
                nodes: [{ id: 'flaky', kind: 'action', implementation: 'fail-once' }],
                edges: [],
                rules: [],
                policies: [],
            },
        });

        // Then
        expect(result.status).toBe('completed');
        expect(attemptsFor(result.events, 'flaky')).toEqual([1, 2]);
        expect(attemptEventTypesFor(result.events, 'flaky')).toEqual([
            'attempt.started',
            'attempt.failed',
            'attempt.started',
            'attempt.completed',
        ]);
        expect(result.events.at(-1)?.type).toBe('graph.completed');
    });

    it('fails with a typed retry-exhausted error after retry cap 2', async () => {
        // Given
        const registry = createAbgNodeRegistry();
        registry.register('always-fail', failTimesBeforeSuccess(Number.POSITIVE_INFINITY));

        // When
        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'retry-exhausted',
                entryNodeId: 'unstable',
                defaults: { retryLimit: 2 },
                nodes: [{ id: 'unstable', kind: 'action', implementation: 'always-fail' }],
                edges: [],
                rules: [],
                policies: [],
            },
        });

        // Then
        expect(result.status).toBe('failed');
        expect(attemptsFor(result.events, 'unstable')).toEqual([1, 2, 3]);
        expect(attemptEventTypesFor(result.events, 'unstable')).toEqual([
            'attempt.started',
            'attempt.failed',
            'attempt.started',
            'attempt.failed',
            'attempt.started',
            'attempt.failed',
        ]);
        expect(result.events.at(-1)).toMatchObject({
            type: 'graph.failed',
            abg: {
                error: {
                    code: 'node_retry_exhausted',
                },
            },
        });
    });

    it('terminates bounded loops with a typed graph limit error', async () => {
        // When
        const result = await runAbgGraph({
            ...baseInput,
            graph: {
                id: 'bounded-loop',
                entryNodeId: 'again',
                defaults: { maxNodeRuns: 3 },
                nodes: [{ id: 'again', kind: 'action' }],
                edges: [{ source: 'again', target: 'again' }],
                rules: [],
                policies: [],
            },
        });

        // Then
        expect(result.status).toBe('failed');
        expect(attemptsFor(result.events, 'again')).toEqual([1, 2, 3]);
        expect(result.events.at(-1)).toMatchObject({
            type: 'graph.failed',
            abg: {
                error: {
                    code: 'graph_loop_limit',
                },
            },
        });
    });

    it('force-completes a node stuck in a tool loop instead of killing the graph', async () => {
        const registry = createAbgNodeRegistry();
        registry.register(
            'always-tool-use',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                context.blackboard?.set('llm.loop_active', true);
                yield createAbgEmitSignal({
                    graphId: context.graphId,
                    nodeId: node.id,
                    eventType: 'tool.completed',
                    timestamp: context.now(),
                });
                yield { type: 'success', graphId: context.graphId, nodeId: node.id };
            },
        );

        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'loop-active-stuck',
                entryNodeId: 'spinner',
                defaults: { retryLimit: 2 },
                nodes: [{ id: 'spinner', kind: 'llm', implementation: 'always-tool-use' }],
                edges: [{ source: 'spinner', target: 'spinner', condition: 'llm-loop-active', priority: 5 }],
                rules: [
                    {
                        id: 'llm-loop-active',
                        description: 'llm loop active',
                        when: { kind: 'blackboard.value.equals', key: 'llm.loop_active', value: true },
                    },
                ],
                policies: [],
            },
        });

        expect(result.status).toBe('completed');
        expect(result.events.some((e) => e.type === 'node.failed' && e.abg?.signalType === 'fallback')).toBe(true);
        expect(result.events.some((e) => e.type === 'graph.completed')).toBe(true);
    });

    it('retries a provider_aborted failure up to the cap instead of failing terminally (no abort signal)', async () => {
        const registry = createAbgNodeRegistry();
        registry.register('always-provider-aborted', failTimesBeforeSuccessWithCode(Number.POSITIVE_INFINITY, 'provider_aborted'));

        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'provider-aborted-retry',
                entryNodeId: 'flaky',
                defaults: { retryLimit: 2 },
                nodes: [{ id: 'flaky', kind: 'llm', implementation: 'always-provider-aborted' }],
                edges: [],
                rules: [],
                policies: [],
            },
        });

        expect(result.status).toBe('failed');
        expect(attemptsFor(result.events, 'flaky')).toEqual([1, 2, 3]);
        expect(result.events.at(-1)).toMatchObject({
            type: 'graph.failed',
            abg: {
                error: {
                    code: 'node_retry_exhausted',
                },
            },
        });
    });

    it('retries a provider_aborted failure and completes when the retry succeeds (transient stream drop)', async () => {
        const registry = createAbgNodeRegistry();
        registry.register('abort-then-success', failTimesBeforeSuccessWithCode(1, 'provider_aborted'));

        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'provider-aborted-transient',
                entryNodeId: 'flaky',
                defaults: { retryLimit: 2 },
                nodes: [{ id: 'flaky', kind: 'llm', implementation: 'abort-then-success' }],
                edges: [],
                rules: [],
                policies: [],
            },
        });

        expect(result.status).toBe('completed');
        expect(attemptsFor(result.events, 'flaky')).toEqual([1, 2]);
    });

    it('short-circuits as provider_aborted when the run-owner abort signal is already set', async () => {
        const registry = createAbgNodeRegistry();
        registry.register('always-fail', failTimesBeforeSuccess(Number.POSITIVE_INFINITY));
        const controller = new AbortController();
        controller.abort();

        const result = await runAbgGraph({
            ...baseInput,
            registry,
            abortSignal: controller.signal,
            graph: {
                id: 'aborted-before-start',
                entryNodeId: 'doomed',
                defaults: { retryLimit: 2 },
                nodes: [{ id: 'doomed', kind: 'action', implementation: 'always-fail' }],
                edges: [],
                rules: [],
                policies: [],
            },
        });

        expect(result.status).toBe('failed');
        expect(result.terminalError).toMatchObject({ code: 'provider_aborted' });
    });

    it('records requires-approval policies as blocked graph state', async () => {
        // When
        const result = await runAbgGraph({
            ...baseInput,
            graph: {
                id: 'blocked-approval',
                entryNodeId: 'write-file',
                nodes: [{ id: 'write-file', kind: 'tool', capabilities: ['filesystem.write'] }],
                edges: [],
                rules: [],
                policies: [
                    {
                        id: 'approval-required',
                        capability: 'filesystem.write',
                        decision: 'requires_approval',
                        reason: 'write requires review',
                    },
                ],
            },
        });

        // Then
        expect(result.status).toBe('blocked');
        expect(result.events.find((event) => event.type === 'permission.requested')?.permissionDecision).toEqual({
            requestId: 'permission_blocked-approval_write-file',
            status: 'requires_approval',
            reason: 'write requires review',
        });
        expect(result.events.at(-1)).toMatchObject({
            type: 'graph.failed',
            abg: {
                error: {
                    code: 'policy_blocked',
                },
            },
        });
        expect(deriveAbgGraphSnapshot(result.events, 'blocked-approval').status).toBe('blocked');
    });
});

function linearGraph() {
    return {
        id: 'linear',
        entryNodeId: 'start',
        nodes: [
            { id: 'start', kind: 'action' },
            { id: 'finish', kind: 'action' },
        ],
        edges: [{ source: 'start', target: 'finish' }],
        rules: [],
        policies: [],
    };
}

function failTimesBeforeSuccess(failures: number) {
    let runs = 0;
    return async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
        runs += 1;
        yield { type: 'started', graphId: context.graphId, nodeId: node.id };
        if (runs <= failures) {
            yield { type: 'failure', graphId: context.graphId, nodeId: node.id, error: { code: 'temporary' } };
            return;
        }
        yield { type: 'success', graphId: context.graphId, nodeId: node.id };
    };
}

function failTimesBeforeSuccessWithCode(failures: number, code: string) {
    let runs = 0;
    return async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
        runs += 1;
        yield { type: 'started', graphId: context.graphId, nodeId: node.id };
        if (runs <= failures) {
            yield { type: 'failure', graphId: context.graphId, nodeId: node.id, error: { code } };
            return;
        }
        yield { type: 'success', graphId: context.graphId, nodeId: node.id };
    };
}

function attemptsFor(events: readonly AgentEvent[], nodeId: string) {
    const attempts = events
        .filter((event) => event.abg?.nodeId === nodeId && event.abg.attempt !== undefined)
        .map((event) => event.abg?.attempt);
    return [...new Set(attempts)];
}

function attemptEventTypesFor(events: readonly AgentEvent[], nodeId: string) {
    return events
        .filter((event) => event.abg?.nodeId === nodeId && event.type.startsWith('attempt.'))
        .map((event) => event.type);
}
