import { findResumableRun, type GraphResumeEvent, type ResumableRunSnapshot } from '@mission-control/core';
import { GraphCheckpointSchema } from '@mission-control/protocol';

export type WorkResumeDecision =
    | {
          readonly kind: 'approval';
          readonly snapshot: Extract<ResumableRunSnapshot, { readonly kind: 'approval' }>;
      }
    | {
          readonly kind: 'interrupted';
          readonly snapshot: Extract<ResumableRunSnapshot, { readonly kind: 'interrupted' }>;
      }
    | {
          readonly kind: 'interrupt_without_checkpoint';
      }
    | {
          readonly kind: 'nothing_to_resume';
      };

export function decideWorkResume(events: readonly GraphResumeEvent[]): WorkResumeDecision {
    const resumable = findResumableRun(events);
    if (resumable !== undefined) {
        switch (resumable.kind) {
            case 'approval':
                return { kind: 'approval', snapshot: resumable };
            case 'interrupted':
                return { kind: 'interrupted', snapshot: resumable };
            default:
                return assertNever(resumable);
        }
    }
    if (newestInterruptLacksCheckpoint(events)) {
        return { kind: 'interrupt_without_checkpoint' };
    }
    return { kind: 'nothing_to_resume' };
}

export function formatWorkResumeStartMessage(decision: WorkResumeDecision, sessionId: string): string {
    switch (decision.kind) {
        case 'approval': {
            const detail = approvalDetail(decision.snapshot);
            return `Resuming run for ${sessionId} (blocked on approval — ${detail})\n`;
        }
        case 'interrupted': {
            const nodes = decision.snapshot.checkpoint.queuedNodeIds.join(', ');
            return `Resuming interrupted run for ${sessionId} from queued node(s): ${nodes}\n`;
        }
        case 'interrupt_without_checkpoint':
            return (
                `Nothing to resume for ${sessionId}: last run was interrupted without a graph checkpoint. ` +
                'Send a new prompt or re-invoke the workflow.\n'
            );
        case 'nothing_to_resume':
            return (
                `Nothing to resume for ${sessionId}. ` +
                'No approval-blocked or interrupted checkpoint run is waiting.\n'
            );
        default:
            return assertNever(decision);
    }
}

export function isWorkResumeActionable(
    decision: WorkResumeDecision,
): decision is Extract<WorkResumeDecision, { readonly kind: 'approval' | 'interrupted' }> {
    return decision.kind === 'approval' || decision.kind === 'interrupted';
}

function approvalDetail(snapshot: Extract<ResumableRunSnapshot, { readonly kind: 'approval' }>): string {
    if (snapshot.reason !== undefined && snapshot.reason.length > 0) {
        return snapshot.reason;
    }
    if (snapshot.toolCallId !== undefined) {
        return `waiting for approval: ${snapshot.toolCallId}`;
    }
    return 'waiting for approval';
}

function newestInterruptLacksCheckpoint(events: readonly GraphResumeEvent[]): boolean {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event === undefined) continue;
        if (isFullTerminalRunEvent(event)) return false;
        if (event.type !== 'run.interrupted') continue;
        const runId = event.run?.runId;
        if (runId === undefined) continue;
        return !hasParseableCheckpointInRunWindow(events, index, runId);
    }
    return false;
}

function hasParseableCheckpointInRunWindow(
    events: readonly GraphResumeEvent[],
    beforeIndex: number,
    runId: string,
): boolean {
    for (let index = beforeIndex - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event === undefined) continue;
        if (isFullTerminalRunEvent(event)) return false;
        if (event.type === 'run.started' && event.run?.runId === runId) return false;
        if (event.type !== 'graph.checkpoint') continue;
        const parsed = GraphCheckpointSchema.safeParse(event.abg?.checkpoint);
        if (!parsed.success) continue;
        if (checkpointBindsRun(parsed.data.sessionRunId, event.run?.runId, runId)) {
            return true;
        }
    }
    return false;
}

function checkpointBindsRun(
    checkpointSessionRunId: string | undefined,
    eventRunId: string | undefined,
    runId: string,
): boolean {
    if (checkpointSessionRunId !== undefined || eventRunId !== undefined) {
        return checkpointSessionRunId === runId || eventRunId === runId;
    }
    return true;
}

function isFullTerminalRunEvent(event: GraphResumeEvent): boolean {
    return event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.idle';
}

function assertNever(value: never): never {
    throw new Error(`Unexpected work-resume variant: ${String(value)}`);
}
