import type { AbgNodeSpec, AbgSignal, AgentEvent } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
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
