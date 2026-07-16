import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createObservabilityRedactor } from '../providers/observability-redactor';
import { CANONICAL_FAILURE_CODES } from './failure-taxonomy';
import { runAbgGraph } from './graph-runner';
import type { AbgNodeRunContext } from './node-registry';
import { createAbgNodeRegistry } from './node-registry';

const baseInput = {
    sessionId: 'session_progress_obs',
    now: () => '2026-07-16T00:00:00.000Z',
    modelProviderSelection: {
        providerID: 'local',
        modelID: 'local-echo',
    },
} as const;

describe('progress-contract observability (todo 9)', () => {
    it('emits durable routing.dead_end payloads with nodeId+code on re-admit and failGraph terminal', async () => {
        // Given: permanent poison gate, conditional-only outbound, retryLimit 1 → 2 attempts
        const registry = createAbgNodeRegistry();
        registry.register(
            'always-poison',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                context.blackboard?.set('ambiguity.classification', { blob: true });
                yield { type: 'success', graphId: context.graphId, nodeId: node.id };
            },
        );

        // When
        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'obs-dead-end-exhaust',
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

        // Then: failed run, never completed
        expect(result.status).toBe('failed');
        expect(result.terminalError?.code).toBe(CANONICAL_FAILURE_CODES.ROUTING_DEAD_END);
        expect(result.events.some((event) => event.type === 'graph.completed')).toBe(false);

        // Re-admit emits: durable abg.emit with nodeId + code + attempt
        const deadEndEmits = result.events.filter((event) => event.abg?.emit?.type === 'routing.dead_end');
        expect(deadEndEmits.length).toBeGreaterThanOrEqual(2);
        for (const event of deadEndEmits) {
            expect(event.durability).toBe('durable');
            expect(event.abg?.nodeId).toBe('gate');
            expect(event.abg?.emit?.payload).toEqual(
                expect.objectContaining({
                    nodeId: 'gate',
                    code: CANONICAL_FAILURE_CODES.ROUTING_DEAD_END,
                }),
            );
            const payload = event.abg?.emit?.payload;
            expect(typeof payload === 'object' && payload !== null && 'attempt' in payload).toBe(true);
        }
        const attempts = deadEndEmits
            .map((event) => {
                const payload = event.abg?.emit?.payload;
                if (typeof payload !== 'object' || payload === null || !('attempt' in payload)) {
                    return undefined;
                }
                return typeof payload.attempt === 'number' ? payload.attempt : undefined;
            })
            .filter((value): value is number => value !== undefined);
        expect(attempts).toEqual(expect.arrayContaining([1, 2]));

        // failGraph terminal: graph.failed carries typed code
        const graphFailed = result.events.find((event) => event.type === 'graph.failed');
        expect(graphFailed).toBeDefined();
        expect(graphFailed?.abg?.error?.code).toBe(CANONICAL_FAILURE_CODES.ROUTING_DEAD_END);
        expect(graphFailed?.message).toContain('gate');
        expect(result.terminalError?.message).toContain('gate');
    });

    it('persists invalid_structured_output nodeId+code on retrying node.failed events', async () => {
        // Given: structured failure then success under budget
        const registry = createAbgNodeRegistry();
        let runs = 0;
        registry.register(
            'structured-then-ok',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                runs += 1;
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                if (runs === 1) {
                    yield {
                        type: 'failure',
                        graphId: context.graphId,
                        nodeId: node.id,
                        error: {
                            code: CANONICAL_FAILURE_CODES.INVALID_STRUCTURED_OUTPUT,
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
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                yield { type: 'success', graphId: context.graphId, nodeId: node.id };
            },
        );

        // When
        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'obs-structured-admission',
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
                            outputEnum: ['clear', 'unclear'],
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

        // Then: run recovers; first failure event carries durable nodeId+code
        expect(result.status).toBe('completed');
        const structuredFailures = result.events.filter(
            (event) =>
                event.type === 'node.failed' &&
                event.abg?.nodeId === 'gate' &&
                event.abg?.error?.code === CANONICAL_FAILURE_CODES.INVALID_STRUCTURED_OUTPUT,
        );
        expect(structuredFailures.length).toBeGreaterThanOrEqual(1);
        expect(structuredFailures[0]?.durability).toBe('durable');
        expect(structuredFailures[0]?.abg?.error?.message).toContain('output outside enum');
    });

    it('redacts secrets from structured-output correction payloads on re-queue', async () => {
        // Given: invalid_structured_output with secret in error message + observability redactor
        // When: node re-queues under budget
        // Then: retryCorrection does not contain the raw secret
        const secret = ['sk', 'live', 'corrsecret456'].join('-');
        const registry = createAbgNodeRegistry();
        const corrections: Array<string | undefined> = [];
        let runs = 0;
        registry.register(
            'structured-secret-then-ok',
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
                            code: CANONICAL_FAILURE_CODES.INVALID_STRUCTURED_OUTPUT,
                            message: `output outside enum; leaked ${secret}`,
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
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                yield { type: 'success', graphId: context.graphId, nodeId: node.id };
            },
        );

        const result = await runAbgGraph({
            ...baseInput,
            registry,
            observabilityRedactor: createObservabilityRedactor({ secrets: [secret] }),
            graph: {
                id: 'obs-correction-redaction',
                entryNodeId: 'gate',
                defaults: { retryLimit: 2 },
                nodes: [
                    {
                        id: 'gate',
                        kind: 'action',
                        implementation: 'structured-secret-then-ok',
                        capabilities: [],
                        config: {
                            outputKey: 'ambiguity.classification',
                            outputEnum: ['clear', 'unclear'],
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
        expect(corrections[1]).not.toContain(secret);
    });

    it('keeps routing.dead_end payload free of observed poison and secrets out of messages', async () => {
        // Given: secret only in poison blob (must not appear in durable emit payload)
        const secret = ['sk', 'live', 'obssecret123'].join('-');
        const registry = createAbgNodeRegistry();
        registry.register(
            'poison-with-secret',
            async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
                yield { type: 'started', graphId: context.graphId, nodeId: node.id };
                context.blackboard?.set('ambiguity.classification', {
                    token: secret,
                    prose: `leaked ${secret}`,
                });
                yield { type: 'success', graphId: context.graphId, nodeId: node.id };
            },
        );

        // When
        const result = await runAbgGraph({
            ...baseInput,
            registry,
            observabilityRedactor: createObservabilityRedactor({ secrets: [secret] }),
            graph: {
                id: 'obs-dead-end-redaction',
                entryNodeId: 'gate',
                defaults: { retryLimit: 0 },
                nodes: [
                    {
                        id: 'gate',
                        kind: 'action',
                        implementation: 'poison-with-secret',
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

        // Then: typed dead-end; structural emit payload has nodeId+code only (no observed blob)
        expect(result.status).toBe('failed');
        expect(result.terminalError?.code).toBe(CANONICAL_FAILURE_CODES.ROUTING_DEAD_END);
        const deadEnd = result.events.find((event) => event.abg?.emit?.type === 'routing.dead_end');
        expect(deadEnd).toBeDefined();
        expect(deadEnd?.abg?.emit?.payload).toEqual({
            nodeId: 'gate',
            code: CANONICAL_FAILURE_CODES.ROUTING_DEAD_END,
            attempt: 1,
        });
        expect(JSON.stringify(deadEnd?.abg?.emit?.payload)).not.toContain(secret);
        expect(JSON.stringify(result.events.map((event) => event.message))).not.toContain(secret);
    });
});
