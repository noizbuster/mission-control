import type { GraphCheckpoint } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import {
    decideWorkResume,
    formatWorkResumeStartMessage,
    isWorkResumeActionable,
    type WorkResumeDecision,
} from './work-resume-decision';

const TIMESTAMP = '2026-07-20T00:00:00.000Z';

describe('decideWorkResume', () => {
    it('classifies an approval-blocked run as approval', () => {
        // Given: a run blocked on approval with tool metadata.
        const events = [
            runEvent('run.started', 'run-a', 'running'),
            runEvent('run.blocked', 'run-a', 'blocked_on_approval', {
                reason: 'waiting for approval: file.patch',
                toolCallId: 'tool-a',
            }),
        ];

        // When: /continue classifies cold session events.
        const decision = decideWorkResume(events);

        // Then: the actionable approval kind is selected.
        expect(decision).toEqual({
            kind: 'approval',
            snapshot: {
                kind: 'approval',
                runId: 'run-a',
                reason: 'waiting for approval: file.patch',
                toolCallId: 'tool-a',
            },
        });
        expect(isWorkResumeActionable(decision)).toBe(true);
    });

    it('classifies an interrupted run with queued checkpoint as interrupted', () => {
        // Given: interrupt checkpoint still has queued graph work.
        const checkpoint = makeCheckpoint({ sessionRunId: 'run-i', queuedNodeIds: ['entry', 'verify'] });
        const events = [
            runEvent('run.started', 'run-i', 'running'),
            checkpointEvent(checkpoint, 'run-i'),
            runEvent('run.interrupted', 'run-i', 'interrupted', { reason: 'user_interrupt' }),
        ];

        // When: /continue classifies cold session events.
        const decision = decideWorkResume(events);

        // Then: the interrupted kind carries the checkpoint cursor.
        expect(decision.kind).toBe('interrupted');
        if (decision.kind !== 'interrupted') throw new Error('expected interrupted');
        expect(decision.snapshot.runId).toBe('run-i');
        expect(decision.snapshot.checkpoint.queuedNodeIds).toEqual(['entry', 'verify']);
        expect(isWorkResumeActionable(decision)).toBe(true);
    });

    it('starts safe recovery instead of replaying a provider-aborted interrupted checkpoint', () => {
        // Given: legacy persistence marked a provider abort as run.interrupted with queued work.
        const checkpoint = makeCheckpoint({ sessionRunId: 'run-provider-abort', queuedNodeIds: ['delegate-wave'] });
        const events = [
            runEvent('run.started', 'run-provider-abort', 'running'),
            checkpointEvent(checkpoint, 'run-provider-abort'),
            runEvent('run.interrupted', 'run-provider-abort', 'interrupted', { reason: 'provider_aborted' }),
        ];

        // When: /continue classifies the legacy provider abort.
        const decision = decideWorkResume(events);

        // Then: it starts a guarded fresh run rather than executing the stale cursor.
        expect(decision).toEqual({ kind: 'recovery', sourceRunId: 'run-provider-abort' });
        expect(isWorkResumeActionable(decision)).toBe(false);
    });

    it('starts safe recovery for an interrupted task receipt instead of replaying an older checkpoint', () => {
        // Given: a provider abort left a completed failure tail after an earlier queued checkpoint.
        const safeCheckpoint = makeCheckpoint({ sessionRunId: 'run-recovery', queuedNodeIds: ['delegate-wave'] });
        const terminalCheckpoint = makeCheckpoint({ sessionRunId: 'run-recovery', queuedNodeIds: [] });
        const events = [
            runEvent('run.started', 'run-recovery', 'running'),
            checkpointEvent(safeCheckpoint, 'run-recovery'),
            checkpointEvent(terminalCheckpoint, 'run-recovery'),
            runEvent('task.failed', 'run-recovery', 'interrupted'),
        ];

        // When: /continue evaluates the interrupted session.
        const decision = decideWorkResume(events);

        // Then: it starts a fresh guarded run rather than replaying delegate-wave.
        expect(decision).toEqual({ kind: 'recovery', sourceRunId: 'run-recovery' });
        expect(isWorkResumeActionable(decision)).toBe(false);
    });

    it('starts safe recovery for an interrupt without a checkpoint', () => {
        // Given: an interrupted run with no graph.checkpoint in its window.
        const events = [
            runEvent('run.started', 'run-bare', 'running'),
            runEvent('run.interrupted', 'run-bare', 'interrupted'),
        ];

        // When: /continue classifies cold session events.
        const decision = decideWorkResume(events);

        // Then: an explicit command starts a guarded fresh run.
        expect(decision).toEqual({ kind: 'recovery', sourceRunId: 'run-bare' });
        expect(isWorkResumeActionable(decision)).toBe(false);
    });

    it('does not recover an older interruption after a newer run has started', () => {
        // Given: a prior interrupted tail followed by an active successor run.
        const events = [
            runEvent('task.failed', 'run-old', 'interrupted'),
            runEvent('run.started', 'run-current', 'running'),
        ];

        // When: /continue scans the cold session history.
        const decision = decideWorkResume(events);

        // Then: it never revives the older run over the newer owner.
        expect(decision).toEqual({ kind: 'nothing_to_resume' });
    });
    it('classifies a completed tip as nothing_to_resume (no loop)', () => {
        // Given: a completed run after an earlier interrupt checkpoint.
        const events = [
            checkpointEvent(makeCheckpoint({ sessionRunId: 'run-done', queuedNodeIds: ['next'] }), 'run-done'),
            runEvent('run.interrupted', 'run-done', 'interrupted'),
            runEvent('run.completed', 'run-done', 'completed'),
        ];

        // When: /continue classifies cold session events.
        const decision = decideWorkResume(events);

        // Then: completed work is not resumable.
        expect(decision).toEqual({ kind: 'nothing_to_resume' });
        expect(isWorkResumeActionable(decision)).toBe(false);
    });

    it('starts safe recovery when the latest interruption checkpoint has an empty queue', () => {
        // Given: the empty queue cannot safely be rewound to an older graph state.
        const events = [
            checkpointEvent(makeCheckpoint({ sessionRunId: 'run-empty', queuedNodeIds: [] }), 'run-empty'),
            runEvent('run.interrupted', 'run-empty', 'interrupted'),
        ];

        // When: /continue classifies cold session events.
        const decision = decideWorkResume(events);

        // Then: a new guarded run is available without replaying the old checkpoint.
        expect(decision).toEqual({ kind: 'recovery', sourceRunId: 'run-empty' });
    });
});

describe('formatWorkResumeStartMessage', () => {
    it('emits an approval hint that keeps the Resuming run prefix', () => {
        // Given: an approval decision with a reason.
        const decision: WorkResumeDecision = {
            kind: 'approval',
            snapshot: {
                kind: 'approval',
                runId: 'run-a',
                reason: 'waiting for approval: file.patch',
                toolCallId: 'tool-a',
            },
        };

        // When: the start message is formatted.
        const message = formatWorkResumeStartMessage(decision, 'session_x');

        // Then: blocked-path regression keeps the Resuming run token and approval hint.
        expect(message).toContain('Resuming run for session_x');
        expect(message).toContain('blocked on approval');
        expect(message).toContain('waiting for approval: file.patch');
    });

    it('emits a queued-node hint for interrupt+checkpoint', () => {
        // Given: an interrupted decision with two queued nodes.
        const decision: WorkResumeDecision = {
            kind: 'interrupted',
            snapshot: {
                kind: 'interrupted',
                runId: 'run-i',
                checkpoint: makeCheckpoint({ sessionRunId: 'run-i', queuedNodeIds: ['entry', 'verify'] }),
            },
        };

        // When: the start message is formatted.
        const message = formatWorkResumeStartMessage(decision, 'session_x');

        // Then: the node cursor is surfaced for the operator.
        expect(message).toContain('Resuming interrupted run for session_x');
        expect(message).toContain('queued node(s): entry, verify');
    });

    it('announces safe recovery without claiming it will replay the interrupted graph', () => {
        // Given: a non-replay recovery decision.
        const decision: WorkResumeDecision = { kind: 'recovery', sourceRunId: 'run_recovery' };

        // When: the start message is formatted.
        const message = formatWorkResumeStartMessage(decision, 'session_x');

        // Then: it states the tail is ignored and workspace inspection comes first.
        expect(message).toContain('Starting safe recovery for session_x');
        expect(message).toContain('interrupted tail will not be replayed');
        expect(message).toContain('inspect the current workspace');
    });

    it('emits a plain nothing-to-resume message', () => {
        // Given: nothing_to_resume.
        const decision: WorkResumeDecision = { kind: 'nothing_to_resume' };

        // When: the start message is formatted.
        const message = formatWorkResumeStartMessage(decision, 'session_x');

        // Then: the nothing-to-resume token is present.
        expect(message).toContain('Nothing to resume for session_x');
        expect(message).toContain('No approval-blocked or interrupted checkpoint run is waiting');
    });
});

function runEvent(
    type:
        | 'run.started'
        | 'run.blocked'
        | 'run.interrupted'
        | 'run.completed'
        | 'run.failed'
        | 'run.idle'
        | 'task.failed',
    runId: string,
    state: 'running' | 'blocked_on_approval' | 'interrupted' | 'completed' | 'failed' | 'idle',
    extra: { readonly reason?: string; readonly toolCallId?: string } = {},
) {
    return {
        type,
        timestamp: TIMESTAMP,
        run: {
            runId,
            state,
            ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
            ...(extra.toolCallId !== undefined ? { toolCallId: extra.toolCallId } : {}),
        },
    };
}

function checkpointEvent(checkpoint: GraphCheckpoint, runId: string) {
    return {
        type: 'graph.checkpoint' as const,
        timestamp: TIMESTAMP,
        run: { runId, state: 'running' as const },
        abg: { graphId: checkpoint.graphId, checkpoint },
    };
}

function makeCheckpoint(input: {
    readonly sessionRunId: string;
    readonly queuedNodeIds: readonly string[];
}): GraphCheckpoint {
    return {
        schemaVersion: 1,
        graphId: 'graph-main',
        sessionRunId: input.sessionRunId,
        reason: 'interrupt',
        queuedNodeIds: [...input.queuedNodeIds],
        completedNodeIds: [],
        nodeStatuses: {},
        attemptsByNodeId: {},
        consecutiveFailuresByNodeId: {},
        consecutiveToolFailuresByNodeId: {},
        totalNodeRuns: 0,
        budgetExtensionsUsed: 0,
        maxNodeRuns: 64,
        blackboardEntries: {},
        activeParallelParentIds: [],
        createdAt: TIMESTAMP,
    };
}
