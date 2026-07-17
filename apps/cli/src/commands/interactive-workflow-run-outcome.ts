import { redactCredentialText } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import type { WorkflowRunOutcome } from './run-agent-workflow-run';

export type TrackedWorkflowRunOutcome = WorkflowRunOutcome | { readonly status: 'pending' };

type OutcomePriority = 'task' | 'owner' | 'interruption';

type ObservedOutcome =
    | { readonly kind: 'blocked'; readonly outcome: Extract<WorkflowRunOutcome, { readonly status: 'blocked' }> }
    | {
          readonly kind: 'terminal';
          readonly priority: OutcomePriority;
          readonly outcome: Exclude<WorkflowRunOutcome, { readonly status: 'blocked' }>;
      };

type ObserverState =
    | { readonly kind: 'pending' }
    | { readonly kind: 'blocked'; readonly outcome: Extract<WorkflowRunOutcome, { readonly status: 'blocked' }> }
    | {
          readonly kind: 'terminal';
          readonly priority: OutcomePriority;
          readonly outcome: Exclude<WorkflowRunOutcome, { readonly status: 'blocked' }>;
      };

export type WorkflowRunOutcomeObserver = {
    readonly observe: (event: AgentEvent) => void;
    readonly getOutcome: () => TrackedWorkflowRunOutcome;
    readonly settle: (fallback?: WorkflowRunOutcome) => Promise<void>;
};

export function redactWorkflowError(error: unknown): Error {
    return new Error(safeReason(error instanceof Error ? error.message : String(error)));
}

type WorkflowRunOutcomeObserverOptions = {
    readonly expectedSessionId?: string;
    readonly expectedTaskId?: string;
    readonly requireOwnerRunIdentity?: boolean;
    readonly settleOutcome: (outcome: WorkflowRunOutcome, sessionRunId?: string) => Promise<void>;
};

const OUTCOME_PRIORITY: Readonly<Record<OutcomePriority, number>> = {
    task: 0,
    owner: 1,
    interruption: 2,
};

export function createWorkflowRunOutcomeObserver(
    options: WorkflowRunOutcomeObserverOptions,
): WorkflowRunOutcomeObserver {
    let state: ObserverState = { kind: 'pending' };
    let settlement: Promise<void> | undefined;
    let ownerRunId: string | undefined;
    return {
        observe(event): void {
            if (options.expectedSessionId !== undefined && event.sessionId !== options.expectedSessionId) return;
            if (event.type === 'run.started') {
                ownerRunId ??= event.run?.runId;
                return;
            }
            if (
                event.type.startsWith('run.') &&
                options.expectedSessionId !== undefined &&
                (ownerRunId === undefined || event.run?.runId !== ownerRunId)
            )
                return;
            if (event.type.startsWith('task.') && options.expectedTaskId !== undefined) {
                if (event.taskId !== options.expectedTaskId) return;
                if (options.requireOwnerRunIdentity === true && ownerRunId === undefined) return;
                if (event.run?.runId !== undefined && ownerRunId !== undefined && event.run.runId !== ownerRunId)
                    return;
            }
            const observed = outcomeFromEvent(event);
            if (observed === undefined) return;
            if (observed.kind === 'blocked') {
                if (state.kind !== 'terminal') state = observed;
                return;
            }
            if (state.kind !== 'terminal' || OUTCOME_PRIORITY[observed.priority] > OUTCOME_PRIORITY[state.priority]) {
                state = observed;
            }
        },
        getOutcome(): TrackedWorkflowRunOutcome {
            return state.kind === 'pending' ? { status: 'pending' } : state.outcome;
        },
        settle(fallback?: WorkflowRunOutcome): Promise<void> {
            if (settlement !== undefined) return settlement;
            const outcome = state.kind === 'pending' ? fallback : state.outcome;
            if (outcome === undefined) return Promise.resolve();
            settlement =
                ownerRunId === undefined ? options.settleOutcome(outcome) : options.settleOutcome(outcome, ownerRunId);
            return settlement;
        },
    };
}

function outcomeFromEvent(event: AgentEvent): ObservedOutcome | undefined {
    switch (event.type) {
        case 'run.blocked':
            return {
                kind: 'blocked',
                outcome: {
                    status: 'blocked',
                    ...(event.message !== undefined ? { reason: safeReason(event.message) } : {}),
                },
            };
        case 'run.interrupted':
            return {
                kind: 'terminal',
                priority: 'interruption',
                outcome: {
                    status: 'cancelled',
                    reason: safeReason(event.run?.reason ?? event.message ?? 'workflow turn cancelled'),
                },
            };
        case 'run.completed':
            return { kind: 'terminal', priority: 'owner', outcome: { status: 'completed' } };
        case 'run.failed':
            return {
                kind: 'terminal',
                priority: 'owner',
                outcome: {
                    status: 'failed',
                    ...(event.message !== undefined ? { reason: safeReason(event.message) } : {}),
                },
            };
        case 'task.completed':
            return { kind: 'terminal', priority: 'task', outcome: { status: 'completed' } };
        case 'task.failed':
            return event.run?.state === 'interrupted'
                ? {
                      kind: 'terminal',
                      priority: 'interruption',
                      outcome: {
                          status: 'cancelled',
                          reason: safeReason(event.run.reason ?? event.message ?? 'workflow turn cancelled'),
                      },
                  }
                : {
                      kind: 'terminal',
                      priority: 'task',
                      outcome: {
                          status: 'failed',
                          ...(event.message !== undefined ? { reason: safeReason(event.message) } : {}),
                      },
                  };
        default:
            return undefined;
    }
}

function safeReason(reason: string): string {
    return redactCredentialText(reason).slice(0, 4096);
}

export function formatWorkflowTurnFooter(
    elapsedMs: number,
    outcome: TrackedWorkflowRunOutcome,
): string {
    const seconds = Math.max(0, elapsedMs) / 1000;
    const elapsedLabel = seconds >= 10 ? seconds.toFixed(1) : seconds.toFixed(2);
    return `\n---\nTurn elapsed: ${elapsedLabel}s · Stop reason: ${describeWorkflowStopReason(outcome)}\n`;
}

function describeWorkflowStopReason(outcome: TrackedWorkflowRunOutcome): string {
    switch (outcome.status) {
        case 'pending':
            return 'unknown (no terminal event)';
        case 'completed':
            return 'completed';
        case 'failed':
            return outcome.reason === undefined || outcome.reason.length === 0
                ? 'failed'
                : `failed (${outcome.reason})`;
        case 'blocked':
            return outcome.reason === undefined || outcome.reason.length === 0
                ? 'blocked'
                : `blocked (${outcome.reason})`;
        case 'cancelled':
            return `cancelled (${outcome.reason})`;
        default:
            return assertNeverOutcome(outcome);
    }
}

function assertNeverOutcome(value: never): never {
    throw new Error(`Unexpected workflow outcome: ${JSON.stringify(value)}`);
}
