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
    for (const event of events) {
        if (event.approvalRecord?.state === 'pending') {
            latestPendingApproval = event.approvalRecord;
        }
        if (clearsAwaiting(event)) {
            awaiting = undefined;
        }
        if (event.type === 'run.started') {
            sawRunLifecycle = true;
            hasActiveRun = true;
        }
        if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.interrupted') {
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
    }
    return {
        id: sessionId,
        status: replaySessionStatus({ stoppedAt, awaiting, sawRunLifecycle, hasActiveRun }),
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

function clearsAwaiting(event: AgentEvent): boolean {
    switch (event.type) {
        case 'approval.updated':
        case 'approval.resumed':
        case 'tool.completed':
        case 'run.completed':
        case 'run.failed':
        case 'run.interrupted':
        case 'session.stopped':
            return true;
        default:
            return false;
    }
}
