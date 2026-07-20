// allow: SIZE_OK -- HEAD 0 -> current 352 pure LOC; one hybrid ABG session-resume regression matrix locking interrupt cold-continue, empty-BB plain prompt, approval path, and ContinuationRuntime anti-scope.
/**
 * Hybrid ABG session-resume regression pack (plan todo 12).
 *
 * Locks the core contracts that must stay green for cold attach + /continue:
 * 1. two-node interrupt → cold events → continue → second node once
 * 3. attach → plain prompt empty BB (command=run never seeds checkpoint)
 * 4. approval path still works on resume
 * 6. ContinuationRuntime is not required on the production resume driver path
 *
 * CLI contracts 2 and 5 live in apps/cli session-resume-abg-regression.test.ts
 * and the existing workflow-resume / attach projection suites.
 */

import type {
    AbgNodeSpec,
    AbgSignal,
    AgentEvent,
    GraphCheckpoint,
    ModelProviderSelection,
} from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { approvalGraph } from '../behavior/graph-coordinator-test-support';
import { runAbgGraph } from '../behavior/graph-runner';
import type { AbgNodeRunContext } from '../behavior/node-registry';
import { createAbgNodeRegistry } from '../behavior/node-registry';
import { createGraphTurnRunner } from './graph-coordinator-turn';
import { findResumableRun } from './graph-resume-state';
import type { RunCoordinatorTurnContext } from './run-coordinator-types';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NOW = '2026-07-20T00:00:00.000Z';
const MODEL: ModelProviderSelection = { providerID: 'local', modelID: 'local-echo' };
const SESSION_ID = 'session_resume_regression';
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_SRC = join(HERE, '..');

/** Production modules on the hybrid ABG resume path (must not drive ContinuationRuntime). */
const RESUME_PATH_SOURCES = [
    join(HERE, 'graph-coordinator-turn.ts'),
    join(HERE, 'graph-resume-state.ts'),
    join(HERE, 'run-coordinator-engine.ts'),
    join(HERE, 'run-coordinator-drain.ts'),
    join(HERE, 'run-coordinator-types.ts'),
    join(CORE_SRC, 'behavior', 'graph-coordinator-resume.ts'),
    join(CORE_SRC, 'behavior', 'graph-checkpoint-emit.ts'),
    join(CORE_SRC, 'behavior', 'checkpoint-blackboard-snapshot.ts'),
] as const;

describe('session-resume ABG regression pack (core)', () => {
    it('1. two-node interrupt → cold events → continue → second node once', async () => {
        // Given: a real first pass that completes gate and checkpoints the queued successor.
        const graphId = 'regression-two-node-interrupt';
        const runId = 'run_regression_interrupt';
        const firstExecuted: string[] = [];
        const first = await runAbgGraph({
            graph: linearGraph(graphId),
            sessionId: SESSION_ID,
            now: () => NOW,
            modelProviderSelection: MODEL,
            registry: probeRegistry(firstExecuted, {
                onGate: (context) => {
                    context.blackboard?.set('plan.ready', true);
                },
            }),
        });
        expect(first.status).toBe('completed');
        expect(firstExecuted).toEqual(['gate', 'next']);
        const boundary = checkpoints(first.events).find(
            (candidate) => candidate.reason === 'node_boundary' && candidate.completedNodeIds.includes('gate'),
        );
        expect(boundary).toBeDefined();
        if (boundary === undefined) {
            throw new Error('expected node-boundary checkpoint after gate');
        }
        // Cold ledger: same checkpoint rewritten as interrupt reason + run.interrupted terminal.
        const coldCheckpoint: GraphCheckpoint = {
            ...boundary,
            reason: 'interrupt',
            sessionRunId: runId,
            queuedNodeIds: ['next'],
            completedNodeIds: ['gate'],
            nodeStatuses: { ...boundary.nodeStatuses, gate: 'succeeded' },
        };
        const coldEvents = interruptedSessionEvents({ runId, checkpoint: coldCheckpoint });

        // When: cold loader classifies the run, then the turn runner continues with command=resume.
        const resumable = findResumableRun(coldEvents);
        expect(resumable?.kind).toBe('interrupted');
        if (resumable?.kind !== 'interrupted') {
            throw new Error('expected interrupted resumable run');
        }
        const continueExecuted: string[] = [];
        const runner = createGraphTurnRunner({
            graph: linearGraph(graphId),
            sessionId: SESSION_ID,
            now: () => NOW,
            modelProviderSelection: MODEL,
            registry: probeRegistry(continueExecuted),
        });
        const result = await runner(turnContext({ command: 'resume', sessionEvents: coldEvents }));

        // Then: only the second node runs once; gate is not re-executed.
        expect(result.status).toBe('completed');
        expect(continueExecuted).toEqual(['next']);
        expect(resumable.checkpoint.queuedNodeIds).toEqual(['next']);
    });

    it('3. plain prompt after attach starts empty BB and does not seed checkpoint', async () => {
        // Given: ledger still holds an interrupt checkpoint with durable BB entries.
        const graphId = 'regression-plain-prompt-empty-bb';
        const runId = 'run_plain_prompt';
        const checkpoint: GraphCheckpoint = {
            schemaVersion: 1,
            graphId,
            sessionRunId: runId,
            reason: 'interrupt',
            queuedNodeIds: ['next'],
            completedNodeIds: ['gate'],
            nodeStatuses: { gate: 'succeeded' },
            attemptsByNodeId: { gate: 1 },
            consecutiveFailuresByNodeId: {},
            consecutiveToolFailuresByNodeId: {},
            totalNodeRuns: 1,
            budgetExtensionsUsed: 0,
            maxNodeRuns: 64,
            blackboardEntries: { 'plan.ready': true, 'intent.classification': 'explicit-implementation' },
            activeParallelParentIds: [],
            createdAt: NOW,
        };
        const seenBlackboards: Readonly<Record<string, unknown>>[] = [];
        const executed: string[] = [];
        const runner = createGraphTurnRunner({
            graph: linearGraph(graphId),
            sessionId: SESSION_ID,
            now: () => NOW,
            modelProviderSelection: MODEL,
            registry: probeRegistry(executed, {
                onAny: (context) => {
                    seenBlackboards.push(context.blackboard?.toRecord() ?? {});
                },
            }),
        });

        // When: a normal run (plain prompt after attach) is promoted — not resume.
        const result = await runner(
            turnContext({
                command: 'run',
                sessionEvents: interruptedSessionEvents({ runId, checkpoint }),
                messages: [{ role: 'user', content: 'fresh plain prompt' }],
            }),
        );

        // Then: entry restarts with empty BB; checkpoint BB keys are not silently rehydrated.
        expect(result.status).toBe('completed');
        expect(executed).toEqual(['gate', 'next']);
        expect(seenBlackboards[0]).toEqual({});
        expect(seenBlackboards.some((record) => 'plan.ready' in record)).toBe(false);
    });

    it('4. approval resume still completes without re-running a succeeded gate', async () => {
        // Given: approval-blocked style resume with a completed gate already in the checkpoint.
        const graphId = 'regression-approval-path';
        const runId = 'run_approval_path';
        const checkpoint: GraphCheckpoint = {
            schemaVersion: 1,
            graphId,
            sessionRunId: runId,
            reason: 'approval_block',
            queuedNodeIds: ['next'],
            completedNodeIds: ['gate'],
            nodeStatuses: { gate: 'succeeded' },
            attemptsByNodeId: { gate: 1 },
            consecutiveFailuresByNodeId: {},
            consecutiveToolFailuresByNodeId: {},
            totalNodeRuns: 1,
            budgetExtensionsUsed: 0,
            maxNodeRuns: 64,
            blackboardEntries: {},
            activeParallelParentIds: [],
            createdAt: NOW,
        };
        const executed: string[] = [];
        const runner = createGraphTurnRunner({
            graph: linearGraph(graphId),
            sessionId: SESSION_ID,
            now: () => NOW,
            modelProviderSelection: MODEL,
            registry: probeRegistry(executed),
            readApprovalDecisions: async () => [
                {
                    id: 'approval_decided_regression',
                    type: 'approval.updated',
                    source: 'human',
                    timestamp: NOW,
                    payload: {
                        approvalId: `approval_permission_${graphId}_approve`,
                        state: 'approved',
                        reason: 'approved in regression pack',
                    },
                },
            ],
        });

        // When: /continue-style resume runs with threaded approval decisions.
        const result = await runner(
            turnContext({
                command: 'resume',
                sessionEvents: [
                    {
                        type: 'run.started',
                        timestamp: NOW,
                        sessionId: SESSION_ID,
                        message: 'run started',
                        run: { runId, command: 'run', state: 'running' },
                    },
                    {
                        type: 'graph.checkpoint',
                        timestamp: NOW,
                        sessionId: SESSION_ID,
                        run: { runId },
                        abg: { graphId, checkpoint },
                    },
                    {
                        type: 'run.blocked',
                        timestamp: NOW,
                        sessionId: SESSION_ID,
                        message: 'blocked',
                        run: {
                            runId,
                            command: 'run',
                            state: 'blocked_on_approval',
                            toolCallId: 'tool_regression',
                        },
                    },
                ],
            }),
        );

        // Then: approval path completes and does not double-execute the gate.
        expect(result.status).toBe('completed');
        expect(executed).toEqual(['next']);
    });

    it('4b. human-approval graph still blocks without a decision (approval path intact)', async () => {
        // Given: the stock approval graph with no decision source.
        const runner = createGraphTurnRunner({
            graph: approvalGraph('regression-approval-block'),
            sessionId: SESSION_ID,
            now: () => NOW,
            modelProviderSelection: MODEL,
        });

        // When: a fresh run hits the approval gate.
        const result = await runner(turnContext({ command: 'run' }));

        // Then: the path still blocks rather than auto-approving.
        expect(result.status).toBe('blocked_on_approval');
    });

    it('6. hybrid ABG resume path does not import or require ContinuationRuntime', async () => {
        // Given: production source files that implement cold checkpoint resume.
        // Anti-scope: C7 ContinuationRuntime.runWithContinuation must stay unwired here.
        for (const sourcePath of RESUME_PATH_SOURCES) {
            const source = readFileSync(sourcePath, 'utf8');
            expect(source, sourcePath).not.toMatch(/\bContinuationRuntime\b/);
            expect(source, sourcePath).not.toMatch(/\brunWithContinuation\b/);
        }

        // When/Then: resume still completes using only findResumableRun + createGraphTurnRunner.
        const graphId = 'regression-no-continuation-runtime';
        const runId = 'run_no_cr';
        const checkpoint: GraphCheckpoint = {
            schemaVersion: 1,
            graphId,
            sessionRunId: runId,
            reason: 'interrupt',
            queuedNodeIds: ['next'],
            completedNodeIds: ['gate'],
            nodeStatuses: { gate: 'succeeded' },
            attemptsByNodeId: { gate: 1 },
            consecutiveFailuresByNodeId: {},
            consecutiveToolFailuresByNodeId: {},
            totalNodeRuns: 1,
            budgetExtensionsUsed: 0,
            maxNodeRuns: 64,
            blackboardEntries: { 'plan.ready': true },
            activeParallelParentIds: [],
            createdAt: NOW,
        };
        const executed: string[] = [];
        const runner = createGraphTurnRunner({
            graph: linearGraph(graphId),
            sessionId: SESSION_ID,
            now: () => NOW,
            modelProviderSelection: MODEL,
            registry: probeRegistry(executed),
        });
        const result = await runner(
            turnContext({
                command: 'resume',
                sessionEvents: interruptedSessionEvents({ runId, checkpoint }),
            }),
        );
        expect(result.status).toBe('completed');
        expect(executed).toEqual(['next']);
    });
});

function linearGraph(graphId: string) {
    return {
        id: graphId,
        entryNodeId: 'gate',
        nodes: [
            { id: 'gate', kind: 'action' as const, implementation: 'probe-gate' },
            { id: 'next', kind: 'action' as const, implementation: 'probe-next' },
        ],
        edges: [{ source: 'gate', target: 'next' }],
        rules: [],
        policies: [],
    };
}

function probeRegistry(
    executed: string[],
    hooks: {
        readonly onGate?: (context: AbgNodeRunContext) => void;
        readonly onAny?: (context: AbgNodeRunContext) => void;
    } = {},
) {
    const registry = createAbgNodeRegistry();
    const probe = async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
        executed.push(node.id);
        hooks.onAny?.(context);
        if (node.id === 'gate') {
            hooks.onGate?.(context);
        }
        yield { type: 'started', graphId: context.graphId, nodeId: node.id };
        yield { type: 'success', graphId: context.graphId, nodeId: node.id };
    };
    registry.register('probe-gate', probe);
    registry.register('probe-next', probe);
    return registry;
}

function turnContext(input: {
    readonly command: RunCoordinatorTurnContext['command'];
    readonly sessionEvents?: readonly AgentEvent[];
    readonly messages?: readonly { readonly role: 'user'; readonly content: string }[];
}): RunCoordinatorTurnContext {
    const sessionEvents = input.sessionEvents;
    return {
        signal: new AbortController().signal,
        command: input.command,
        ...(sessionEvents !== undefined ? { readSessionEvents: async () => sessionEvents } : {}),
        readMessages: async () => input.messages ?? [{ role: 'user', content: 'continue' }],
        nextId: async (prefix) => `${prefix}_regression`,
        appendDurableEvent: async () => {},
        appendDurableEnvelope: async () => {},
    };
}

function interruptedSessionEvents(input: {
    readonly runId: string;
    readonly checkpoint: GraphCheckpoint;
}): AgentEvent[] {
    return [
        {
            type: 'run.started',
            timestamp: NOW,
            sessionId: SESSION_ID,
            message: 'run started',
            run: { runId: input.runId, command: 'run', state: 'running' },
        },
        {
            type: 'graph.checkpoint',
            timestamp: NOW,
            sessionId: SESSION_ID,
            run: { runId: input.runId },
            abg: { graphId: input.checkpoint.graphId, checkpoint: input.checkpoint },
        },
        {
            type: 'run.interrupted',
            timestamp: NOW,
            sessionId: SESSION_ID,
            message: 'run interrupted',
            run: {
                runId: input.runId,
                command: 'run',
                state: 'interrupted',
                reason: 'provider_aborted',
            },
        },
    ];
}

function checkpoints(events: readonly AgentEvent[]): readonly GraphCheckpoint[] {
    return events.flatMap((event) => {
        const checkpoint = event.abg?.checkpoint;
        return event.type === 'graph.checkpoint' && checkpoint !== undefined ? [checkpoint] : [];
    });
}
