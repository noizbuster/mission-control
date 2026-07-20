import { describe, expect, it } from 'vitest';
import { approvalGraph } from '../behavior/graph-coordinator-test-support';
import { runAbgGraph } from '../behavior/graph-runner';
import { createGraphTurnRunner } from './graph-coordinator-turn';
import { findResumableRun } from './graph-resume-state';
import {
    approvalBlockedEvent,
    approvalDecisionEvent,
    checkpoints,
    graphCheckpointEvent,
    interruptedSessionEvents,
    linearGraph,
    makeRegressionCheckpoint,
    probeRegistry,
    readResumePathSourceTexts,
    runStartedEvent,
    SESSION_RESUME_REGRESSION_MODEL,
    SESSION_RESUME_REGRESSION_NOW,
    SESSION_RESUME_REGRESSION_SESSION_ID,
    turnContext,
} from './session-resume-abg-regression-test-support';

describe('session-resume ABG regression pack (core)', () => {
    it('1. two-node interrupt → cold events → continue → second node once', async () => {
        // Given: a real first pass that completes gate and checkpoints the queued successor.
        const graphId = 'regression-two-node-interrupt';
        const runId = 'run_regression_interrupt';
        const firstExecuted: string[] = [];
        const first = await runAbgGraph({
            graph: linearGraph(graphId),
            sessionId: SESSION_RESUME_REGRESSION_SESSION_ID,
            now: () => SESSION_RESUME_REGRESSION_NOW,
            modelProviderSelection: SESSION_RESUME_REGRESSION_MODEL,
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
        const coldCheckpoint = {
            ...boundary,
            reason: 'interrupt' as const,
            sessionRunId: runId,
            queuedNodeIds: ['next'],
            completedNodeIds: ['gate'],
            nodeStatuses: { ...boundary.nodeStatuses, gate: 'succeeded' as const },
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
            sessionId: SESSION_RESUME_REGRESSION_SESSION_ID,
            now: () => SESSION_RESUME_REGRESSION_NOW,
            modelProviderSelection: SESSION_RESUME_REGRESSION_MODEL,
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
        const checkpoint = makeRegressionCheckpoint({
            graphId,
            runId,
            reason: 'interrupt',
            queuedNodeIds: ['next'],
            completedNodeIds: ['gate'],
            blackboardEntries: { 'plan.ready': true, 'intent.classification': 'explicit-implementation' },
        });
        const seenBlackboards: Readonly<Record<string, unknown>>[] = [];
        const executed: string[] = [];
        const runner = createGraphTurnRunner({
            graph: linearGraph(graphId),
            sessionId: SESSION_RESUME_REGRESSION_SESSION_ID,
            now: () => SESSION_RESUME_REGRESSION_NOW,
            modelProviderSelection: SESSION_RESUME_REGRESSION_MODEL,
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
        const checkpoint = makeRegressionCheckpoint({
            graphId,
            runId,
            reason: 'approval_block',
            queuedNodeIds: ['next'],
            completedNodeIds: ['gate'],
        });
        const executed: string[] = [];
        const runner = createGraphTurnRunner({
            graph: linearGraph(graphId),
            sessionId: SESSION_RESUME_REGRESSION_SESSION_ID,
            now: () => SESSION_RESUME_REGRESSION_NOW,
            modelProviderSelection: SESSION_RESUME_REGRESSION_MODEL,
            registry: probeRegistry(executed),
            readApprovalDecisions: async () => [approvalDecisionEvent(graphId)],
        });

        // When: /continue-style resume runs with threaded approval decisions.
        const result = await runner(
            turnContext({
                command: 'resume',
                sessionEvents: [
                    runStartedEvent(runId),
                    graphCheckpointEvent(runId, checkpoint),
                    approvalBlockedEvent({ runId, graphId }),
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
            sessionId: SESSION_RESUME_REGRESSION_SESSION_ID,
            now: () => SESSION_RESUME_REGRESSION_NOW,
            modelProviderSelection: SESSION_RESUME_REGRESSION_MODEL,
        });

        // When: a fresh run hits the approval gate.
        const result = await runner(turnContext({ command: 'run' }));

        // Then: the path still blocks rather than auto-approving.
        expect(result.status).toBe('blocked_on_approval');
    });

    it('6. hybrid ABG resume path does not import or require ContinuationRuntime', async () => {
        // Given: production source files that implement cold checkpoint resume.
        for (const { sourcePath, source } of readResumePathSourceTexts()) {
            expect(source, sourcePath).not.toMatch(/\bContinuationRuntime\b/);
            expect(source, sourcePath).not.toMatch(/\brunWithContinuation\b/);
        }

        // When/Then: resume still completes using only findResumableRun + createGraphTurnRunner.
        const graphId = 'regression-no-continuation-runtime';
        const runId = 'run_no_cr';
        const checkpoint = makeRegressionCheckpoint({
            graphId,
            runId,
            reason: 'interrupt',
            queuedNodeIds: ['next'],
            completedNodeIds: ['gate'],
            blackboardEntries: { 'plan.ready': true },
        });
        const executed: string[] = [];
        const runner = createGraphTurnRunner({
            graph: linearGraph(graphId),
            sessionId: SESSION_RESUME_REGRESSION_SESSION_ID,
            now: () => SESSION_RESUME_REGRESSION_NOW,
            modelProviderSelection: SESSION_RESUME_REGRESSION_MODEL,
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
