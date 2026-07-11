export type SessionLifecycleStatus = 'idle' | 'running' | 'awaiting' | 'stopped' | 'failed';

export type SessionAwaitingReason = 'approval' | 'user_input' | 'subagent';

export type SessionTerminalEvent =
    | { readonly kind: 'none' }
    | { readonly kind: 'stopped' }
    | { readonly kind: 'failed'; readonly reason?: string };

export type SessionActiveRun = {
    readonly runId: string;
};

export type SessionWaitSource =
    | { readonly kind: 'approval'; readonly approvalId: string }
    | { readonly kind: 'operator'; readonly inputId: string }
    | { readonly kind: 'run'; readonly runId: string }
    | {
          readonly kind: 'subagent';
          readonly jobId: string;
          readonly childSessionId?: string;
          readonly mode: 'sync' | 'detached';
      };

export type SessionPendingWait = {
    readonly waitId: string;
    readonly reason: SessionAwaitingReason;
    readonly source: SessionWaitSource;
};

export type SessionBackgroundJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type SessionBackgroundJob = {
    readonly jobId: string;
    readonly blocking: boolean;
    readonly status: SessionBackgroundJobStatus;
    readonly childSessionId?: string;
};

export type SessionMissionRun = {
    readonly runId: string;
    readonly status: 'pending' | 'running' | 'blocked';
};

export type SessionPendingInput = {
    readonly inputId: string;
};

export type SessionAbortMarker = { readonly kind: 'none' } | { readonly kind: 'operator_aborted' };

export type SessionLifecycleDerivationInput = {
    readonly terminalEvent: SessionTerminalEvent;
    readonly activeRuns: readonly SessionActiveRun[];
    readonly pendingWaits: readonly SessionPendingWait[];
    readonly backgroundJobs: readonly SessionBackgroundJob[];
    readonly missionRuns?: readonly SessionMissionRun[];
    readonly pendingInputs?: readonly SessionPendingInput[];
    readonly abortMarker?: SessionAbortMarker;
};

export type SessionLifecycleDerivation =
    | { readonly status: 'idle'; readonly displayReason?: 'aborted' }
    | { readonly status: 'running' }
    | {
          readonly status: 'awaiting';
          readonly awaitingReason: SessionAwaitingReason;
          readonly displayReason: string;
          readonly primaryWaitId: string;
      }
    | { readonly status: 'stopped' }
    | { readonly status: 'failed'; readonly displayReason?: string };

export function deriveSessionLifecycle(input: SessionLifecycleDerivationInput): SessionLifecycleDerivation {
    switch (input.terminalEvent.kind) {
        case 'stopped':
            return { status: 'stopped' };
        case 'failed':
            return input.terminalEvent.reason === undefined
                ? { status: 'failed' }
                : { status: 'failed', displayReason: input.terminalEvent.reason };
        case 'none':
            break;
        default:
            return assertNever(input.terminalEvent);
    }

    const primaryWait = primaryPendingWait(input.pendingWaits, input.backgroundJobs);
    if (primaryWait !== undefined) {
        return {
            status: 'awaiting',
            awaitingReason: primaryWait.reason,
            displayReason: displayReasonFor(primaryWait.reason),
            primaryWaitId: primaryWait.waitId,
        };
    }

    if (
        input.activeRuns.length > 0 ||
        (input.missionRuns?.length ?? 0) > 0 ||
        (input.pendingInputs?.length ?? 0) > 0 ||
        input.backgroundJobs.some((job) => isActiveJobStatus(job.status))
    ) {
        return { status: 'running' };
    }
    return input.abortMarker?.kind === 'operator_aborted'
        ? { status: 'idle', displayReason: 'aborted' }
        : { status: 'idle' };
}

function primaryPendingWait(
    pendingWaits: readonly SessionPendingWait[],
    backgroundJobs: readonly SessionBackgroundJob[],
): SessionPendingWait | undefined {
    return (
        pendingWaits.find((wait) => activeWaitReason(wait, backgroundJobs) === 'approval') ??
        pendingWaits.find((wait) => activeWaitReason(wait, backgroundJobs) === 'user_input') ??
        pendingWaits.find((wait) => activeWaitReason(wait, backgroundJobs) === 'subagent') ??
        blockingJobWait(backgroundJobs)
    );
}

function activeWaitReason(
    wait: SessionPendingWait,
    backgroundJobs: readonly SessionBackgroundJob[],
): SessionAwaitingReason | undefined {
    switch (wait.reason) {
        case 'approval':
            return wait.reason;
        case 'user_input':
            return wait.reason;
        case 'subagent':
            return isBlockingSubagentWait(wait.source, backgroundJobs) ? wait.reason : undefined;
        default:
            return assertNever(wait.reason);
    }
}

function isBlockingSubagentWait(source: SessionWaitSource, backgroundJobs: readonly SessionBackgroundJob[]): boolean {
    switch (source.kind) {
        case 'approval':
        case 'operator':
        case 'run':
            return false;
        case 'subagent':
            return source.mode === 'sync' || isBlockingActiveJob(source.jobId, backgroundJobs);
        default:
            return assertNever(source);
    }
}

function isBlockingActiveJob(jobId: string, backgroundJobs: readonly SessionBackgroundJob[]): boolean {
    const job = backgroundJobs.find((candidate) => candidate.jobId === jobId);
    return job?.blocking === true && isActiveJobStatus(job.status);
}

function blockingJobWait(backgroundJobs: readonly SessionBackgroundJob[]): SessionPendingWait | undefined {
    const job = backgroundJobs.find((candidate) => candidate.blocking && isActiveJobStatus(candidate.status));
    if (job === undefined) {
        return undefined;
    }
    return {
        waitId: job.jobId,
        reason: 'subagent',
        source: {
            kind: 'subagent',
            jobId: job.jobId,
            mode: 'sync',
            ...(job.childSessionId !== undefined ? { childSessionId: job.childSessionId } : {}),
        },
    };
}

function isActiveJobStatus(status: SessionBackgroundJobStatus): boolean {
    switch (status) {
        case 'queued':
        case 'running':
            return true;
        case 'completed':
        case 'failed':
        case 'cancelled':
            return false;
        default:
            return assertNever(status);
    }
}

function displayReasonFor(reason: SessionAwaitingReason): string {
    switch (reason) {
        case 'approval':
            return 'awaiting approval';
        case 'user_input':
            return 'awaiting user input';
        case 'subagent':
            return 'awaiting subagent';
        default:
            return assertNever(reason);
    }
}

function assertNever(value: never): never {
    throw new Error(`unhandled variant: ${String(value)}`);
}
