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
    for (const event of events) {
        if (event.approvalRecord?.state === 'pending') {
            latestPendingApproval = event.approvalRecord;
        }
        if (clearsAwaiting(event)) {
            awaiting = undefined;
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
        status: stoppedAt === undefined ? (awaiting === undefined ? 'running' : 'awaiting') : 'stopped',
        startedAt: sessionStarted?.timestamp ?? new Date(0).toISOString(),
        ...(stoppedAt === undefined && awaiting !== undefined ? { awaiting } : {}),
        ...(stoppedAt !== undefined ? { stoppedAt } : {}),
    };
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
