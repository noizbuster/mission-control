import { findResumableRun, type GraphResumeEvent, type ResumableRunSnapshot } from '@mission-control/core';
import { assertUnreachable } from '../assert-unreachable';

export const SAFE_RECOVERY_PROMPT =
    'A prior run in this session was interrupted. Treat its terminal failure tail as non-authoritative. ' +
    'Before taking any write, command, or network action, inspect the current workspace and conversation to determine ' +
    'what is already complete. Do not repeat potentially side-effecting work unless its current state is verified. ' +
    'Continue only the verified outstanding work; if verification is insufficient, ask the user.';

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
          readonly kind: 'recovery';
          readonly sourceRunId: string;
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
                return isProviderAbortSnapshot(resumable)
                    ? { kind: 'recovery', sourceRunId: resumable.runId }
                    : { kind: 'interrupted', snapshot: resumable };
            default:
                return assertUnreachable(resumable, 'work-resume variant');
        }
    }
    const recoveryRunId = latestInterruptedRunId(events);
    return recoveryRunId === undefined
        ? { kind: 'nothing_to_resume' }
        : { kind: 'recovery', sourceRunId: recoveryRunId };
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
        case 'recovery':
            return (
                `Starting safe recovery for ${sessionId}. The interrupted tail will not be replayed; ` +
                'the new run will inspect the current workspace before continuing.\n'
            );
        case 'nothing_to_resume':
            return (
                `Nothing to resume for ${sessionId}. ` +
                'No approval-blocked or interrupted checkpoint run is waiting.\n'
            );
        default:
            return assertUnreachable(decision, 'work-resume variant');
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

function isProviderAbortSnapshot(snapshot: Extract<ResumableRunSnapshot, { readonly kind: 'interrupted' }>): boolean {
    return snapshot.reason === 'provider_aborted' || snapshot.errorCode === 'provider_aborted';
}

function latestInterruptedRunId(events: readonly GraphResumeEvent[]): string | undefined {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event === undefined) continue;
        if (isFullTerminalRunEvent(event)) return undefined;
        if (event.type === 'run.started') return undefined;
        const runId = event.run?.runId;
        if (runId !== undefined && isInterruptedRunBoundary(event)) return runId;
    }
    return undefined;
}

function isInterruptedRunBoundary(event: GraphResumeEvent): boolean {
    return event.type === 'run.interrupted' || (event.type === 'task.failed' && event.run?.state === 'interrupted');
}

function isFullTerminalRunEvent(event: GraphResumeEvent): boolean {
    return event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.idle';
}
