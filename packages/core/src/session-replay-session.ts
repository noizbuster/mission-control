import type {
    AgentEvent,
    AgentSession,
    ApprovalRecord,
    RunCoordinatorEventMetadata,
    SessionAwaitingDetails,
} from '@mission-control/protocol';

export function deriveReplaySession(sessionId: string, events: readonly AgentEvent[]): AgentSession {
    const sessionStarted = events.find((event) => event.type === 'session.started');
    let stoppedAt: string | undefined;
    let awaiting: SessionAwaitingDetails | undefined;
    let latestPendingApproval: ApprovalRecord | undefined;
    let sawRunLifecycle = false;
    let hasActiveRun = false;
    let abortMarkerActive = false;
    const activeRunIds = new Set<string>();
    for (const event of events) {
        if (event.approvalRecord?.state === 'pending') {
            latestPendingApproval = event.approvalRecord;
        } else if (event.approvalRecord !== undefined) {
            latestPendingApproval = undefined;
        }
        if (clearsAwaiting(event, awaiting)) {
            awaiting = undefined;
        }
        if (event.type === 'run.started' || event.type === 'task.started') {
            sawRunLifecycle = true;
            hasActiveRun = true;
        }
        if (
            event.type === 'run.completed' ||
            event.type === 'run.failed' ||
            event.type === 'run.interrupted' ||
            event.type === 'run.idle' ||
            event.type === 'task.failed' ||
            event.type === 'task.completed'
        ) {
            sawRunLifecycle = true;
            hasActiveRun = false;
        }
        if (event.type === 'run.blocked' && event.run?.state === 'blocked_on_approval') {
            const approvalAwaiting = approvalAwaitingDetails(event.run, latestPendingApproval);
            if (approvalAwaiting !== undefined) {
                awaiting = approvalAwaiting;
            }
        }
        if (event.type === 'node.waiting') {
            awaiting = userInputAwaitingDetails(event.run);
        }
        if (event.type === 'session.stopped') {
            stoppedAt = event.timestamp;
        }
        if (event.type === 'session.abort.completed') {
            abortMarkerActive = true;
        }
        if (event.type === 'run.started') {
            abortMarkerActive = false;
            if (event.run?.runId !== undefined) {
                activeRunIds.add(event.run.runId);
            }
        }
        if (isRunSettlement(event) && event.run?.runId !== undefined) {
            activeRunIds.delete(event.run.runId);
        }
    }
    const status =
        stoppedAt !== undefined
            ? 'stopped'
            : awaiting !== undefined
              ? 'awaiting'
              : abortMarkerActive
                ? activeRunIds.size === 0
                    ? 'idle'
                    : 'running'
                : replaySessionStatus({ stoppedAt, awaiting, sawRunLifecycle, hasActiveRun });
    return {
        id: sessionId,
        status,
        startedAt: sessionStarted?.timestamp ?? new Date(0).toISOString(),
        ...(stoppedAt === undefined && awaiting !== undefined ? { awaiting } : {}),
        ...(stoppedAt !== undefined ? { stoppedAt } : {}),
    };
}

function replaySessionStatus(input: {
    readonly stoppedAt: string | undefined;
    readonly awaiting: SessionAwaitingDetails | undefined;
    readonly sawRunLifecycle: boolean;
    readonly hasActiveRun: boolean;
}): AgentSession['status'] {
    if (input.stoppedAt !== undefined) {
        return 'stopped';
    }
    if (input.awaiting !== undefined) {
        return 'awaiting';
    }
    // Sessions that never emitted run lifecycle events keep the legacy default of
    // `running` so task-only demos and empty projections stay stable. Once a run
    // lifecycle is observed, terminal run events return the session to `idle`.
    if (input.sawRunLifecycle) {
        return input.hasActiveRun ? 'running' : 'idle';
    }
    return 'running';
}

function approvalAwaitingDetails(
    run: RunCoordinatorEventMetadata,
    latestPendingApproval: ApprovalRecord | undefined,
): SessionAwaitingDetails | undefined {
    if (latestPendingApproval === undefined) {
        return undefined;
    }
    return {
        reason: 'approval',
        source: {
            approvalId: latestPendingApproval.approvalId,
            ...(run.runId !== undefined ? { runId: run.runId } : {}),
            ...(run.toolCallId !== undefined ? { toolCallId: run.toolCallId } : {}),
        },
    };
}

function userInputAwaitingDetails(run: RunCoordinatorEventMetadata | undefined): SessionAwaitingDetails {
    return {
        reason: 'user_input',
        source: {
            ...(run?.runId !== undefined ? { runId: run.runId } : {}),
            ...(run?.toolCallId !== undefined ? { toolCallId: run.toolCallId } : {}),
        },
    };
}

function clearsAwaiting(event: AgentEvent, awaiting: SessionAwaitingDetails | undefined): boolean {
    switch (event.type) {
        case 'approval.updated':
        case 'approval.resumed':
        case 'tool.completed':
        case 'run.completed':
        case 'run.failed':
        case 'run.interrupted':
        case 'run.idle':
        case 'session.stopped':
            return true;
        case 'prompt.cancelled':
            return awaiting?.reason === 'user_input' && awaiting.source.inputId === event.transcript?.inputId;
        default:
            return false;
    }
}

function isRunSettlement(event: AgentEvent): boolean {
    switch (event.type) {
        case 'run.completed':
        case 'run.failed':
        case 'run.interrupted':
        case 'run.idle':
        case 'task.failed':
        case 'task.completed':
            return true;
        default:
            return false;
    }
}
