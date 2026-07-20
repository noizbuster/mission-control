import type { AgentEvent, GraphCheckpoint } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import {
    findLatestGraphCheckpoint,
    findResumableRun,
    type GraphResumeEvent,
    latestGraphIdFromEvents,
} from './graph-resume-state';
import { findResumableBlockedRun } from './run-coordinator-drain';

const TIMESTAMP = '2026-07-20T00:00:00.000Z';

type RunMetadata = NonNullable<AgentEvent['run']>;
type RunEventType = 'run.started' | 'run.blocked' | 'run.interrupted' | 'run.completed' | 'run.failed' | 'run.idle';

type RunEventFixture = {
    readonly type: RunEventType;
    readonly runId: string;
    readonly state?: RunMetadata['state'];
    readonly reason?: string;
    readonly errorCode?: RunMetadata['errorCode'];
    readonly toolCallId?: string;
};

type CheckpointFixture = {
    readonly graphId?: string;
    readonly sessionRunId?: string;
    readonly reason?: GraphCheckpoint['reason'];
    readonly queuedNodeIds?: readonly string[];
    readonly completedNodeIds?: readonly string[];
    readonly createdAt?: string;
};

type CheckpointEventFixture = {
    readonly checkpoint?: GraphCheckpoint;
    readonly payload?: unknown;
    readonly runId?: string;
    readonly graphId?: string;
};

function runEvent(input: RunEventFixture): GraphResumeEvent {
    return {
        type: input.type,
        timestamp: TIMESTAMP,
        run: {
            runId: input.runId,
            ...(input.state !== undefined ? { state: input.state } : {}),
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
            ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
            ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
        },
    };
}

function checkpoint(input: CheckpointFixture = {}): GraphCheckpoint {
    return {
        schemaVersion: 1,
        graphId: input.graphId ?? 'graph-main',
        ...(input.sessionRunId !== undefined ? { sessionRunId: input.sessionRunId } : {}),
        reason: input.reason ?? 'node_boundary',
        queuedNodeIds: [...(input.queuedNodeIds ?? ['next-node'])],
        completedNodeIds: [...(input.completedNodeIds ?? ['start'])],
        nodeStatuses: { start: 'succeeded' },
        attemptsByNodeId: { start: 1 },
        consecutiveFailuresByNodeId: {},
        consecutiveToolFailuresByNodeId: {},
        totalNodeRuns: 1,
        budgetExtensionsUsed: 0,
        maxNodeRuns: 64,
        blackboardEntries: {},
        activeParallelParentIds: [],
        createdAt: input.createdAt ?? TIMESTAMP,
    };
}

function checkpointEvent(input: CheckpointEventFixture): GraphResumeEvent {
    const checkpointPayload = input.payload ?? input.checkpoint;
    return {
        type: 'graph.checkpoint',
        timestamp: TIMESTAMP,
        ...(input.runId !== undefined ? { run: { runId: input.runId } } : {}),
        abg: {
            ...(input.graphId !== undefined ? { graphId: input.graphId } : {}),
            ...(checkpointPayload !== undefined ? { checkpoint: checkpointPayload } : {}),
        },
    };
}

describe('findLatestGraphCheckpoint', () => {
    it('returns the latest parseable checkpoint matching graph and session run filters', () => {
        // Given: a matching checkpoint hidden behind newer corrupt and wrong-graph payloads.
        const expected = checkpoint({ sessionRunId: 'run-target', queuedNodeIds: ['resume-node'] });
        const events = [
            checkpointEvent({ checkpoint: expected, graphId: 'graph-main' }),
            checkpointEvent({ payload: { graphId: 'graph-main', reason: 'interrupt' }, graphId: 'graph-main' }),
            checkpointEvent({
                checkpoint: checkpoint({ graphId: 'graph-other', sessionRunId: 'run-target' }),
                graphId: 'graph-other',
            }),
        ];

        // When: the cold loader scans newest first for the target graph and run.
        const latest = findLatestGraphCheckpoint(events, { graphId: 'graph-main', runId: 'run-target' });

        // Then: invalid payloads are skipped instead of poisoning the scan.
        expect(latest).toEqual(expected);
    });

    it('binds a checkpoint to a run through run metadata when sessionRunId is absent', () => {
        // Given: a checkpoint event whose run owner lives only on event.run.
        const expected = checkpoint({ queuedNodeIds: ['metadata-node'] });
        const events = [checkpointEvent({ checkpoint: expected, runId: 'run-from-metadata', graphId: 'graph-main' })];

        // When: the caller filters by run id.
        const latest = findLatestGraphCheckpoint(events, { runId: 'run-from-metadata' });

        // Then: event.run.runId is accepted as the binding authority.
        expect(latest).toEqual(expected);
    });
});

describe('findResumableRun', () => {
    it('returns an approval snapshot for the newest approval-blocked run', () => {
        // Given: a run blocked on approval with no graph checkpoint.
        const events = [
            runEvent({ type: 'run.started', runId: 'run-approval', state: 'running' }),
            runEvent({
                type: 'run.blocked',
                runId: 'run-approval',
                state: 'blocked_on_approval',
                reason: 'waiting for approval',
                errorCode: 'tool_failed',
                toolCallId: 'tool-approval',
            }),
        ];

        // When: resume state is loaded from the cold event stream.
        const resumable = findResumableRun(events);

        // Then: the approval result preserves the legacy blocked-run shape fields.
        expect(resumable).toEqual({
            kind: 'approval',
            runId: 'run-approval',
            reason: 'waiting for approval',
            errorCode: 'tool_failed',
            toolCallId: 'tool-approval',
        });
        expect(findResumableBlockedRun(events)).toEqual({
            runId: 'run-approval',
            reason: 'waiting for approval',
            errorCode: 'tool_failed',
            toolCallId: 'tool-approval',
        });
    });

    it('returns an interrupted run when its window has a queued checkpoint', () => {
        // Given: an interrupted run with a checkpoint that still has queued graph work.
        const resumeCheckpoint = checkpoint({
            sessionRunId: 'run-interrupted',
            reason: 'interrupt',
            queuedNodeIds: ['resume-node'],
        });
        const events = [
            runEvent({ type: 'run.started', runId: 'run-interrupted', state: 'running' }),
            checkpointEvent({ checkpoint: resumeCheckpoint, graphId: 'graph-main' }),
            runEvent({
                type: 'run.interrupted',
                runId: 'run-interrupted',
                state: 'interrupted',
                reason: 'operator_aborted',
            }),
        ];

        // When: resume state is loaded after interruption.
        const resumable = findResumableRun(events);

        // Then: the interrupted run is resumable with its parsed checkpoint.
        expect(resumable).toEqual({
            kind: 'interrupted',
            runId: 'run-interrupted',
            reason: 'operator_aborted',
            checkpoint: resumeCheckpoint,
        });
    });

    it('returns undefined for an interrupted run without a checkpoint', () => {
        // Given: an interrupted run with no graph checkpoint in its window.
        const events = [
            runEvent({ type: 'run.started', runId: 'run-no-checkpoint', state: 'running' }),
            runEvent({ type: 'run.interrupted', runId: 'run-no-checkpoint', state: 'interrupted' }),
        ];

        // When: resume state is loaded.
        const resumable = findResumableRun(events);

        // Then: interruption alone is not enough to resume graph work.
        expect(resumable).toBeUndefined();
    });

    it('returns undefined when a full terminal follows an interrupted run', () => {
        // Given: an interrupted run later settled by a full terminal marker.
        const events = [
            checkpointEvent({
                checkpoint: checkpoint({
                    sessionRunId: 'run-completed',
                    reason: 'interrupt',
                    queuedNodeIds: ['resume-node'],
                }),
                graphId: 'graph-main',
            }),
            runEvent({ type: 'run.interrupted', runId: 'run-completed', state: 'interrupted' }),
            runEvent({ type: 'run.completed', runId: 'run-completed', state: 'completed' }),
        ];

        // When: resume state is loaded after the full terminal.
        const resumable = findResumableRun(events);

        // Then: the earlier interrupted window is dead.
        expect(resumable).toBeUndefined();
    });

    it('prefers a newer approval block over an older interrupted checkpoint', () => {
        // Given: an older interrupted run and a later approval block.
        const events = [
            checkpointEvent({
                checkpoint: checkpoint({ sessionRunId: 'run-old', reason: 'interrupt', queuedNodeIds: ['old-node'] }),
                graphId: 'graph-main',
            }),
            runEvent({ type: 'run.interrupted', runId: 'run-old', state: 'interrupted' }),
            runEvent({
                type: 'run.blocked',
                runId: 'run-new-approval',
                state: 'blocked_on_approval',
                toolCallId: 'tool-new',
            }),
        ];

        // When: resume state is loaded newest first.
        const resumable = findResumableRun(events);

        // Then: the approval block wins because it is the newest resumable run.
        expect(resumable).toEqual({ kind: 'approval', runId: 'run-new-approval', toolCallId: 'tool-new' });
    });

    it('does not resume an approval block after the same run is interrupted', () => {
        // Given: a run blocked on approval and then interrupted without a queued checkpoint.
        const events = [
            runEvent({ type: 'run.blocked', runId: 'run-same', state: 'blocked_on_approval', toolCallId: 'tool-same' }),
            runEvent({ type: 'run.interrupted', runId: 'run-same', state: 'interrupted' }),
        ];

        // When: resume state is loaded.
        const resumable = findResumableRun(events);

        // Then: the interrupt terminal clears that run's approval block.
        expect(resumable).toBeUndefined();
    });

    it('does not let a trailing interrupt for another run hide a valid approval block', () => {
        // Given: a stale interrupt appended after a different run blocked on approval.
        const events = [
            runEvent({ type: 'run.interrupted', runId: 'run-stale', state: 'interrupted' }),
            runEvent({
                type: 'run.blocked',
                runId: 'run-valid-approval',
                state: 'blocked_on_approval',
                toolCallId: 'tool-valid',
            }),
            runEvent({ type: 'run.interrupted', runId: 'run-stale', state: 'interrupted' }),
        ];

        // When: resume state is loaded newest first.
        const resumable = findResumableRun(events);

        // Then: only terminals for the same run can clear that approval block.
        expect(resumable).toEqual({ kind: 'approval', runId: 'run-valid-approval', toolCallId: 'tool-valid' });
    });

    it('returns undefined for an interrupted run with an empty queued checkpoint', () => {
        // Given: the checkpoint is parseable but has no queued graph work.
        const events = [
            checkpointEvent({
                checkpoint: checkpoint({ sessionRunId: 'run-empty', reason: 'interrupt', queuedNodeIds: [] }),
                graphId: 'graph-main',
            }),
            runEvent({ type: 'run.interrupted', runId: 'run-empty', state: 'interrupted' }),
        ];

        // When: resume state is loaded.
        const resumable = findResumableRun(events);

        // Then: an empty queue is not resumable for the interrupt path.
        expect(resumable).toBeUndefined();
    });

    it('skips corrupt checkpoint payloads inside an interrupted run window', () => {
        // Given: a corrupt checkpoint is newer than the valid queued checkpoint.
        const validCheckpoint = checkpoint({
            sessionRunId: 'run-corrupt',
            reason: 'interrupt',
            queuedNodeIds: ['valid'],
        });
        const events = [
            checkpointEvent({ checkpoint: validCheckpoint, graphId: 'graph-main' }),
            checkpointEvent({ payload: { graphId: 'graph-main', queuedNodeIds: ['invalid'] }, graphId: 'graph-main' }),
            runEvent({ type: 'run.interrupted', runId: 'run-corrupt', state: 'interrupted' }),
        ];

        // When: resume state is loaded.
        const resumable = findResumableRun(events);

        // Then: the invalid payload is skipped and the valid checkpoint resumes the run.
        expect(resumable).toEqual({ kind: 'interrupted', runId: 'run-corrupt', checkpoint: validCheckpoint });
    });
});

describe('latestGraphIdFromEvents', () => {
    it('returns undefined when no graph id is present', () => {
        // Given: only run lifecycle events without ABG metadata.
        const events = [runEvent({ type: 'run.started', runId: 'run-1', state: 'running' })];

        // When: the latest graph id is resolved.
        const graphId = latestGraphIdFromEvents(events);

        // Then: no graph id is available.
        expect(graphId).toBeUndefined();
    });

    it('returns the newest abg.graphId when multiple graphs appear', () => {
        // Given: two graph-started markers in chronological order.
        const events: GraphResumeEvent[] = [
            { type: 'graph.started', abg: { graphId: 'graph-old' } },
            { type: 'node.started', abg: { graphId: 'graph-old', nodeId: 'a' } },
            { type: 'graph.started', abg: { graphId: 'graph-new' } },
        ];

        // When: the latest graph id is resolved.
        const graphId = latestGraphIdFromEvents(events);

        // Then: the newest graph wins.
        expect(graphId).toBe('graph-new');
    });

    it('falls back to checkpoint.graphId when abg.graphId is absent', () => {
        // Given: a checkpoint event whose graph id lives only on the payload.
        const events = [
            checkpointEvent({
                checkpoint: checkpoint({ graphId: 'graph-from-checkpoint' }),
            }),
        ];

        // When: the latest graph id is resolved.
        const graphId = latestGraphIdFromEvents(events);

        // Then: the checkpoint graph id is used.
        expect(graphId).toBe('graph-from-checkpoint');
    });
});
