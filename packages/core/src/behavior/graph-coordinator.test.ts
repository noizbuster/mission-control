// allow: SIZE_OK -- HEAD 732 -> current 732 pure LOC; one graph-coordinator state-machine matrix with shared deterministic fixtures.
import type { AbgNodeSpec, AbgSignal, AgentEvent } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createAbgEmitSignal } from './abg-emit';
import { runAbgGraph } from './graph-runner';
import { deriveAbgGraphSnapshot } from './graph-state';
import type { AbgNodeRunContext } from './node-registry';
import { createAbgNodeRegistry, createDefaultAbgNodeRegistry } from './node-registry';

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

    it('soft-lands a tool loop near maxNodeRuns instead of graph_loop_limit', async () => {
        // Given: infinite productive tool self-loop
        // When: totalNodeRuns reaches maxNodeRuns - 1
        // Then: soft-land clears loop_active and graph completes (not graph.failed)
        const registry = createAbgNodeRegistry();
        let runs = 0;
        registry.register(
            'always-tool-use',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                runs += 1;
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
                defaults: { retryLimit: 2, maxNodeRuns: 8 },
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
        expect(runs).toBe(7);
        expect(
            result.events.some((e) => e.type === 'node.failed' && e.abg?.error?.code === 'node_loop_soft_landed'),
        ).toBe(true);
        expect(result.events.some((e) => e.type === 'graph.completed')).toBe(true);
    });

    it('soft-land promotes boolean outputKey so synthesis can still run', async () => {
        // Given: research loops with tools until near maxNodeRuns
        // When: soft-land fires
        // Then: explore.complete=true and final synthesizer runs within the reserved slot
        const registry = createAbgNodeRegistry();
        let researchRuns = 0;
        registry.register(
            'research-tools',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                researchRuns += 1;
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
        registry.register(
            'synth',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                yield {
                    type: 'success',
                    graphId: context.graphId,
                    nodeId: node.id,
                    result: { text: 'synthesis report' },
                };
            },
        );

        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'research-soft-land',
                entryNodeId: 'research',
                defaults: { retryLimit: 2, maxNodeRuns: 8 },
                nodes: [
                    {
                        id: 'research',
                        kind: 'llm',
                        implementation: 'research-tools',
                        config: { outputKey: 'explore.complete', outputShape: 'boolean' },
                    },
                    { id: 'final', kind: 'llm', implementation: 'synth' },
                ],
                edges: [
                    { source: 'research', target: 'final', condition: 'research-complete', priority: 10 },
                    { source: 'research', target: 'research', condition: 'llm-loop-active', priority: 5 },
                ],
                rules: [
                    {
                        id: 'research-complete',
                        description: 'research done',
                        when: { kind: 'blackboard.value.equals', key: 'explore.complete', value: true },
                    },
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
        expect(researchRuns).toBe(7);
        expect(
            result.events.some((e) => e.type === 'node.failed' && e.abg?.error?.code === 'node_loop_soft_landed'),
        ).toBe(true);
        expect(result.events.some((e) => e.type === 'node.completed' && e.abg?.nodeId === 'final')).toBe(true);
    });

    it('soft-lands when the same tool turn fingerprint repeats', async () => {
        // Given: node always completes the same tool call
        // When: identical turn signature hits streak limit (3)
        // Then: soft-land with node_repeated_tool_pattern and promote explore.complete
        const registry = createAbgNodeRegistry();
        let runs = 0;
        registry.register(
            'same-tool',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                runs += 1;
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                context.blackboard?.set('llm.loop_active', true);
                yield createAbgEmitSignal({
                    graphId: context.graphId,
                    nodeId: node.id,
                    eventType: 'llm.tool_call.proposed',
                    timestamp: context.now(),
                    payload: { toolCallId: `c${runs}`, toolName: 'glob', input: { pattern: '**/*' } },
                });
                yield createAbgEmitSignal({
                    graphId: context.graphId,
                    nodeId: node.id,
                    eventType: 'tool.completed',
                    timestamp: context.now(),
                    payload: { toolCallId: `c${runs}`, toolName: 'glob', output: 'ok' },
                });
                yield { type: 'success', graphId: context.graphId, nodeId: node.id };
            },
        );
        registry.register(
            'synth',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                yield { type: 'success', graphId: context.graphId, nodeId: node.id, result: { text: 'done' } };
            },
        );

        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'repeat-tool',
                entryNodeId: 'research',
                defaults: { retryLimit: 2, maxNodeRuns: 64 },
                nodes: [
                    {
                        id: 'research',
                        kind: 'llm',
                        implementation: 'same-tool',
                        config: { outputKey: 'explore.complete', outputShape: 'boolean' },
                    },
                    { id: 'final', kind: 'llm', implementation: 'synth' },
                ],
                edges: [
                    { source: 'research', target: 'final', condition: 'research-complete', priority: 10 },
                    { source: 'research', target: 'research', condition: 'llm-loop-active', priority: 5 },
                ],
                rules: [
                    {
                        id: 'research-complete',
                        description: 'research done',
                        when: { kind: 'blackboard.value.equals', key: 'explore.complete', value: true },
                    },
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
        expect(runs).toBe(3);
        expect(
            result.events.some((e) => e.type === 'node.failed' && e.abg?.error?.code === 'node_repeated_tool_pattern'),
        ).toBe(true);
        expect(result.events.some((e) => e.type === 'node.completed' && e.abg?.nodeId === 'final')).toBe(true);
    });

    it('soft-lands when two tool turns oscillate A↔B', async () => {
        const registry = createAbgNodeRegistry();
        let runs = 0;
        registry.register(
            'ping-pong',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                runs += 1;
                const pattern = runs % 2 === 1 ? '**/*.ts' : '**/*.md';
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                context.blackboard?.set('llm.loop_active', true);
                yield createAbgEmitSignal({
                    graphId: context.graphId,
                    nodeId: node.id,
                    eventType: 'llm.tool_call.proposed',
                    timestamp: context.now(),
                    payload: { toolCallId: `c${runs}`, toolName: 'glob', input: { pattern } },
                });
                yield createAbgEmitSignal({
                    graphId: context.graphId,
                    nodeId: node.id,
                    eventType: 'tool.completed',
                    timestamp: context.now(),
                    payload: { toolCallId: `c${runs}`, toolName: 'glob', output: 'ok' },
                });
                yield { type: 'success', graphId: context.graphId, nodeId: node.id };
            },
        );
        registry.register(
            'synth',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                yield { type: 'success', graphId: context.graphId, nodeId: node.id, result: { text: 'done' } };
            },
        );

        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'oscillate-tool',
                entryNodeId: 'research',
                defaults: { retryLimit: 2, maxNodeRuns: 64 },
                nodes: [
                    {
                        id: 'research',
                        kind: 'llm',
                        implementation: 'ping-pong',
                        config: { outputKey: 'explore.complete', outputShape: 'boolean' },
                    },
                    { id: 'final', kind: 'llm', implementation: 'synth' },
                ],
                edges: [
                    { source: 'research', target: 'final', condition: 'research-complete', priority: 10 },
                    { source: 'research', target: 'research', condition: 'llm-loop-active', priority: 5 },
                ],
                rules: [
                    {
                        id: 'research-complete',
                        description: 'research done',
                        when: { kind: 'blackboard.value.equals', key: 'explore.complete', value: true },
                    },
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
        expect(runs).toBe(4);
        expect(
            result.events.some(
                (e) => e.type === 'node.failed' && e.abg?.error?.code === 'node_oscillating_tool_pattern',
            ),
        ).toBe(true);
        expect(result.events.some((e) => e.type === 'node.completed' && e.abg?.nodeId === 'final')).toBe(true);
    });

    it('fails the graph when the same tool-failure combination repeats', async () => {
        // Given: node "succeeds" but only with the same retryable tool failure each turn
        // When: identical failure signature hits streak limit (3)
        // Then: graph fails with repeated_failure_pattern (before maxAttempts tool-retry path alone)
        const registry = createAbgNodeRegistry();
        let runs = 0;
        registry.register(
            'same-tool-fail',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                runs += 1;
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                context.blackboard?.set('llm.loop_active', true);
                yield createAbgEmitSignal({
                    graphId: context.graphId,
                    nodeId: node.id,
                    eventType: 'llm.tool_call.proposed',
                    timestamp: context.now(),
                    payload: { toolCallId: `f${runs}`, toolName: 'bash', input: { cmd: 'flaky' } },
                });
                yield createAbgEmitSignal({
                    graphId: context.graphId,
                    nodeId: node.id,
                    eventType: 'tool.failed',
                    timestamp: context.now(),
                    payload: {
                        toolCallId: `f${runs}`,
                        toolName: 'bash',
                        error: { code: 'timeout', message: 'timed out', retryable: true },
                    },
                });
                yield { type: 'success', graphId: context.graphId, nodeId: node.id };
            },
        );

        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'repeat-tool-fail',
                entryNodeId: 'flaky',
                defaults: { retryLimit: 10, maxNodeRuns: 64 },
                nodes: [{ id: 'flaky', kind: 'llm', implementation: 'same-tool-fail' }],
                edges: [{ source: 'flaky', target: 'flaky', condition: 'llm-loop-active', priority: 5 }],
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

        expect(result.status).toBe('failed');
        expect(result.terminalError?.code).toBe('repeated_failure_pattern');
        expect(runs).toBe(3);
    });

    it('allows many productive tool turns under maxNodeRuns without soft-land', async () => {
        // Productive research turns must not be capped by a separate small loop budget.
        const registry = createAbgNodeRegistry();
        let runs = 0;
        registry.register(
            'tool-then-done',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                runs += 1;
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                if (runs < 20) {
                    context.blackboard?.set('llm.loop_active', true);
                    yield createAbgEmitSignal({
                        graphId: context.graphId,
                        nodeId: node.id,
                        eventType: 'tool.completed',
                        timestamp: context.now(),
                    });
                } else {
                    context.blackboard?.set('llm.loop_active', false);
                    context.blackboard?.set('explore.complete', true);
                }
                yield { type: 'success', graphId: context.graphId, nodeId: node.id };
            },
        );

        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'long-research',
                entryNodeId: 'research',
                defaults: { retryLimit: 2, maxNodeRuns: 48 },
                nodes: [
                    {
                        id: 'research',
                        kind: 'llm',
                        implementation: 'tool-then-done',
                        config: { outputKey: 'explore.complete', outputShape: 'boolean' },
                    },
                ],
                edges: [
                    {
                        source: 'research',
                        target: 'research',
                        condition: 'llm-loop-active',
                        priority: 5,
                    },
                ],
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
        expect(runs).toBe(20);
        expect(result.events.some((e) => e.abg?.error?.code === 'node_loop_soft_landed')).toBe(false);
    });

    it('retries a provider_aborted failure up to the cap instead of failing terminally (no abort signal)', async () => {
        const registry = createAbgNodeRegistry();
        registry.register(
            'always-provider-aborted',
            failTimesBeforeSuccessWithCode(Number.POSITIVE_INFINITY, 'provider_aborted'),
        );

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

    it('still spends node maxAttempts on rate-limited provider failures even when marked retryExhausted', async () => {
        // Rate-limit / overload is no longer a single-shot terminal: the graph spends its
        // node retry budget so transient ZAI/GLM overload can recover.
        const registry = createAbgNodeRegistry();
        registry.register(
            'retry-exhausted-provider',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                yield {
                    type: 'failure',
                    graphId: context.graphId,
                    nodeId: node.id,
                    error: {
                        code: 'provider_rate_limited',
                        message: 'temporarily overloaded',
                        retryable: true,
                        retryExhausted: true,
                        providerError: true,
                    },
                };
            },
        );

        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'provider-retry-exhausted',
                entryNodeId: 'limited',
                defaults: { retryLimit: 2 },
                nodes: [{ id: 'limited', kind: 'llm', implementation: 'retry-exhausted-provider' }],
                edges: [],
                rules: [],
                policies: [],
            },
        });

        expect(result.status).toBe('failed');
        expect(attemptsFor(result.events, 'limited')).toEqual([1, 2, 3]);
        expect(result.terminalError).toEqual({
            code: 'provider_rate_limited',
            message: 'temporarily overloaded',
            retryable: true,
        });
    });

    it('fails once when a non-retryable provider hard failure is terminal', async () => {
        // Given: providerError with retryable:false (taxonomy terminal class)
        // When: first attempt fails
        // Then: graph fails immediately without spending node maxAttempts
        const registry = createAbgNodeRegistry();
        registry.register(
            'retry-exhausted-unknown',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                yield {
                    type: 'failure',
                    graphId: context.graphId,
                    nodeId: node.id,
                    error: {
                        code: 'unknown',
                        message: 'upstream hard failure',
                        retryable: false,
                        retryExhausted: true,
                        providerError: true,
                    },
                };
            },
        );

        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'provider-retry-exhausted-unknown',
                entryNodeId: 'hard',
                defaults: { retryLimit: 2 },
                nodes: [{ id: 'hard', kind: 'llm', implementation: 'retry-exhausted-unknown' }],
                edges: [],
                rules: [],
                policies: [],
            },
        });

        expect(result.status).toBe('failed');
        expect(attemptsFor(result.events, 'hard')).toEqual([1]);
        expect(result.terminalError).toEqual({
            code: 'unknown',
            message: 'upstream hard failure',
            retryable: false,
        });
    });

    it('does not misclassify a non-provider retryable-false failure as a provider terminal error', async () => {
        // Given
        const registry = createAbgNodeRegistry();
        registry.register(
            'non-provider-failure',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                yield {
                    type: 'failure',
                    graphId: context.graphId,
                    nodeId: node.id,
                    error: { code: 'validation_failed', message: 'invalid action state', retryable: false },
                };
            },
        );

        // When
        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'non-provider-failure',
                entryNodeId: 'invalid',
                defaults: { retryLimit: 2 },
                nodes: [{ id: 'invalid', kind: 'action', implementation: 'non-provider-failure' }],
                edges: [],
                rules: [],
                policies: [],
            },
        });

        // Then
        expect(attemptsFor(result.events, 'invalid')).toEqual([1, 2, 3]);
        expect(result.events.at(-1)?.message).not.toContain('provider error');
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

    it('completes when a successful node is an intentional terminal sink (zero outbound)', async () => {
        // Given: present / complete / blocked-escalation style sink — zero authored edges
        // When: the sink node succeeds
        // Then: graph completes (intentional terminal, not dead-end)
        const result = await runAbgGraph({
            ...baseInput,
            graph: {
                id: 'intentional-sink',
                entryNodeId: 'present',
                nodes: [{ id: 'present', kind: 'action' }],
                edges: [],
                rules: [],
                policies: [],
            },
        });

        expect(result.status).toBe('completed');
        expect(result.events.at(-1)?.type).toBe('graph.completed');
    });

    /**
     * P1 / routing dead-end (todo 5 green).
     * Poison classification blob + conditional-only equals edges must not silent-complete.
     */
    it('does not complete when conditional-only routing misses after success (P1 dead-end RED lock)', async () => {
        // Given: pure gate + only conditional equals edges + non-matching poison value
        const registry = createAbgNodeRegistry();
        registry.register(
            'write-poison-classification',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                context.blackboard?.set('ambiguity.classification', {
                    prose: 'not an enum label',
                    nested: true,
                });
                yield { type: 'success', graphId: context.graphId, nodeId: node.id };
            },
        );

        // When
        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'routing-dead-end-p1',
                entryNodeId: 'assess-ambiguity',
                defaults: { retryLimit: 2 },
                nodes: [
                    {
                        id: 'assess-ambiguity',
                        kind: 'action',
                        implementation: 'write-poison-classification',
                        capabilities: [],
                        config: {
                            outputKey: 'ambiguity.classification',
                            outputEnum: ['clear', 'unclear', 'on-the-fence'],
                        },
                    },
                    { id: 'clear-path', kind: 'action' },
                    { id: 'unclear-path', kind: 'action' },
                    { id: 'fence-path', kind: 'action' },
                ],
                edges: [
                    { source: 'assess-ambiguity', target: 'clear-path', condition: 'is-clear' },
                    { source: 'assess-ambiguity', target: 'unclear-path', condition: 'is-unclear' },
                    { source: 'assess-ambiguity', target: 'fence-path', condition: 'is-fence' },
                ],
                rules: [
                    {
                        id: 'is-clear',
                        when: {
                            kind: 'blackboard.value.equals',
                            key: 'ambiguity.classification',
                            value: 'clear',
                        },
                    },
                    {
                        id: 'is-unclear',
                        when: {
                            kind: 'blackboard.value.equals',
                            key: 'ambiguity.classification',
                            value: 'unclear',
                        },
                    },
                    {
                        id: 'is-fence',
                        when: {
                            kind: 'blackboard.value.equals',
                            key: 'ambiguity.classification',
                            value: 'on-the-fence',
                        },
                    },
                ],
                policies: [],
            },
        });

        // Then: dead-end re-admit exhausts budget → typed fail, never completed
        expect(result.status).not.toBe('completed');
        expect(result.status).toBe('failed');
        expect(result.terminalError?.code).toBe('routing_dead_end');
        expect(
            result.events.some(
                (event) =>
                    event.message.includes('routing.dead_end') ||
                    event.abg?.emit?.type === 'routing.dead_end' ||
                    event.abg?.error?.code === 'routing_dead_end',
            ),
        ).toBe(true);
        expect(result.events.some((event) => event.abg?.nodeId === 'clear-path')).toBe(false);
        expect(result.events.some((event) => event.abg?.nodeId === 'unclear-path')).toBe(false);
        expect(result.events.some((event) => event.abg?.nodeId === 'fence-path')).toBe(false);
    });

    it('re-queues provider_timeout with retryExhausted when node budget remains (P2)', async () => {
        // Given: provider timeout + retryExhausted while consecutiveFailures < maxAttempts
        // When: first attempt fails
        // Then: node is re-queued (not terminal); second attempt succeeds
        const registry = createAbgNodeRegistry();
        let runs = 0;
        registry.register(
            'timeout-then-ok',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                runs += 1;
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                if (runs === 1) {
                    yield {
                        type: 'failure',
                        graphId: context.graphId,
                        nodeId: node.id,
                        error: {
                            code: 'provider_timeout',
                            message: 'fetch failed',
                            retryable: true,
                            retryExhausted: true,
                            providerError: true,
                        },
                    };
                    return;
                }
                yield { type: 'success', graphId: context.graphId, nodeId: node.id };
            },
        );

        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'provider-timeout-p2',
                entryNodeId: 'flaky',
                defaults: { retryLimit: 2 },
                nodes: [{ id: 'flaky', kind: 'llm', implementation: 'timeout-then-ok' }],
                edges: [],
                rules: [],
                policies: [],
            },
        });

        expect(result.status).toBe('completed');
        expect(runs).toBe(2);
        expect(attemptsFor(result.events, 'flaky')).toEqual([1, 2]);
    });

    it('injects correction on structured rejection and clears after success (P5)', async () => {
        // Given: invalid_structured_output then success
        // When: node is re-queued under budget
        // Then: second attempt sees retryCorrection; third path after success has none
        const registry = createAbgNodeRegistry();
        const corrections: Array<string | undefined> = [];
        let runs = 0;
        registry.register(
            'structured-then-ok',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                runs += 1;
                corrections.push(context.retryCorrection);
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                if (runs === 1) {
                    yield {
                        type: 'failure',
                        graphId: context.graphId,
                        nodeId: node.id,
                        error: {
                            code: 'invalid_structured_output',
                            message: 'output outside enum',
                        },
                    };
                    return;
                }
                context.blackboard?.set('ambiguity.classification', 'clear');
                yield { type: 'success', graphId: context.graphId, nodeId: node.id };
            },
        );
        registry.register(
            'sink',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                corrections.push(context.retryCorrection);
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                yield { type: 'success', graphId: context.graphId, nodeId: node.id };
            },
        );

        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'correction-p5',
                entryNodeId: 'gate',
                defaults: { retryLimit: 2 },
                nodes: [
                    {
                        id: 'gate',
                        kind: 'action',
                        implementation: 'structured-then-ok',
                        capabilities: [],
                        config: {
                            outputKey: 'ambiguity.classification',
                            outputEnum: ['clear', 'unclear', 'on-the-fence'],
                        },
                    },
                    { id: 'clear-path', kind: 'action', implementation: 'sink' },
                ],
                edges: [{ source: 'gate', target: 'clear-path', condition: 'is-clear' }],
                rules: [
                    {
                        id: 'is-clear',
                        when: {
                            kind: 'blackboard.value.equals',
                            key: 'ambiguity.classification',
                            value: 'clear',
                        },
                    },
                ],
                policies: [],
            },
        });

        expect(result.status).toBe('completed');
        expect(corrections[0]).toBeUndefined();
        expect(corrections[1]).toEqual(expect.stringContaining('invalid_structured_output'));
        expect(corrections[1]).toEqual(expect.stringContaining('clear|unclear|on-the-fence'));
        // After productive success, downstream sink must not inherit gate correction
        expect(corrections[2]).toBeUndefined();
    });

    it('fails typed when permanent dead-end exhausts budget (not completed)', async () => {
        // Given: always-poison gate with no escalationTarget
        // When: dead-end re-admits until maxAttempts
        // Then: failGraph routing_dead_end, never graph.completed
        const registry = createAbgNodeRegistry();
        registry.register(
            'always-poison',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                context.blackboard?.set('ambiguity.classification', { blob: true });
                yield { type: 'success', graphId: context.graphId, nodeId: node.id };
            },
        );

        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'dead-end-exhaust',
                entryNodeId: 'gate',
                defaults: { retryLimit: 1 },
                nodes: [
                    {
                        id: 'gate',
                        kind: 'action',
                        implementation: 'always-poison',
                        capabilities: [],
                        config: { outputKey: 'ambiguity.classification', outputEnum: ['clear'] },
                    },
                    { id: 'next', kind: 'action' },
                ],
                edges: [{ source: 'gate', target: 'next', condition: 'is-clear' }],
                rules: [
                    {
                        id: 'is-clear',
                        when: {
                            kind: 'blackboard.value.equals',
                            key: 'ambiguity.classification',
                            value: 'clear',
                        },
                    },
                ],
                policies: [],
            },
        });

        expect(result.status).toBe('failed');
        expect(result.terminalError?.code).toBe('routing_dead_end');
        expect(result.events.some((event) => event.type === 'graph.completed')).toBe(false);
        expect(attemptsFor(result.events, 'gate')).toEqual([1, 2]);
    });

    it('progresses when a conditional equals edge matches after success', async () => {
        // Given: same gate shape as P1 but value is a valid enum label
        const registry = createDefaultAbgNodeRegistry();
        registry.register(
            'write-clear-classification',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                context.blackboard?.set('ambiguity.classification', 'clear');
                yield { type: 'success', graphId: context.graphId, nodeId: node.id };
            },
        );

        // When
        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'routing-match-happy',
                entryNodeId: 'assess-ambiguity',
                nodes: [
                    {
                        id: 'assess-ambiguity',
                        kind: 'action',
                        implementation: 'write-clear-classification',
                        capabilities: [],
                    },
                    { id: 'clear-path', kind: 'action' },
                    { id: 'unclear-path', kind: 'action' },
                ],
                edges: [
                    { source: 'assess-ambiguity', target: 'clear-path', condition: 'is-clear' },
                    { source: 'assess-ambiguity', target: 'unclear-path', condition: 'is-unclear' },
                ],
                rules: [
                    {
                        id: 'is-clear',
                        when: {
                            kind: 'blackboard.value.equals',
                            key: 'ambiguity.classification',
                            value: 'clear',
                        },
                    },
                    {
                        id: 'is-unclear',
                        when: {
                            kind: 'blackboard.value.equals',
                            key: 'ambiguity.classification',
                            value: 'unclear',
                        },
                    },
                ],
                policies: [],
            },
        });

        // Then: matching edge enqueues clear-path; graph completes intentionally at sink
        expect(result.status).toBe('completed');
        expect(result.events.some((event) => event.abg?.nodeId === 'clear-path')).toBe(true);
        expect(result.events.some((event) => event.abg?.nodeId === 'unclear-path')).toBe(false);
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
