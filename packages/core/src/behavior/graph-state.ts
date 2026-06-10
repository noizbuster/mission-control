import {
    type AbgGraphSnapshot,
    AbgGraphSnapshotSchema,
    type AbgGraphStatus,
    type AbgNodeSnapshot,
    type AbgNodeStatus,
    type AbgToolOutcomeSnapshot,
    type AgentEvent,
    type ApprovalRecord,
} from '@mission-control/protocol';

export function deriveAbgGraphSnapshot(events: readonly AgentEvent[], graphId: string): AbgGraphSnapshot {
    const nodes = new Map<string, AbgNodeSnapshot>();
    const approvals = new Map<string, ApprovalRecord>();
    const toolOutcomes = new Map<string, AbgToolOutcomeSnapshot>();
    let status: AbgGraphStatus = 'created';

    for (const event of events) {
        if (event.abg?.graphId !== graphId) {
            continue;
        }
        status = graphStatusForEvent(event, status);
        if (event.approvalRecord !== undefined) {
            approvals.set(event.approvalRecord.approvalId, event.approvalRecord);
        }
        const toolId = toolIdForEvent(event);
        if (toolId !== undefined) {
            const toolOutcome = nextToolOutcome(toolOutcomes.get(toolId), event);
            if (toolOutcome !== undefined) {
                toolOutcomes.set(toolOutcome.toolId, toolOutcome);
            }
        }
        const nodeId = event.abg.nodeId;
        if (nodeId === undefined) {
            continue;
        }
        const nodeStatus = nodeStatusForEvent(event.type);
        if (nodeStatus === undefined) {
            continue;
        }
        nodes.set(nodeId, {
            nodeId,
            status: nodeStatus,
            ...(event.abg.signalType !== undefined ? { lastSignalType: event.abg.signalType } : {}),
        });
    }

    const nodeSnapshots = [...nodes.values()];
    return AbgGraphSnapshotSchema.parse({
        graphId,
        status,
        activeNodeIds: nodeSnapshots.filter((node) => node.status === 'running').map((node) => node.nodeId),
        nodes: nodeSnapshots,
        approvals: [...approvals.values()],
        toolOutcomes: [...toolOutcomes.values()],
    });
}

function graphStatusForEvent(event: AgentEvent, current: AbgGraphStatus): AbgGraphStatus {
    switch (event.type) {
        case 'graph.started':
            return 'active';
        case 'graph.completed':
            return 'completed';
        case 'graph.failed':
            if (isBlockedGraphError(event.abg?.error?.code)) {
                return 'blocked';
            }
            return 'failed';
        case 'graph.cancelled':
            return 'cancelled';
        case 'policy.blocked':
            return current === 'completed' ? current : 'blocked';
        default:
            return current;
    }
}

function isBlockedGraphError(code: string | undefined): boolean {
    return code === 'policy_blocked' || code === 'approval_required' || code === 'approval_blocked';
}

function nodeStatusForEvent(eventType: AgentEvent['type']): AbgNodeStatus | undefined {
    switch (eventType) {
        case 'node.started':
        case 'node.waiting':
        case 'node.progress':
            return 'running';
        case 'node.completed':
            return 'succeeded';
        case 'node.failed':
            return 'failed';
        case 'node.cancelled':
            return 'cancelled';
        case 'policy.blocked':
            return 'blocked';
        default:
            return undefined;
    }
}

function nextToolOutcome(
    current: AbgToolOutcomeSnapshot | undefined,
    event: AgentEvent,
): AbgToolOutcomeSnapshot | undefined {
    const toolId = toolIdForEvent(event);
    if (toolId === undefined) {
        return undefined;
    }
    switch (event.type) {
        case 'tool.started':
            return {
                toolId,
                status: 'started',
                startedAt: event.timestamp,
                ...(event.message !== undefined ? { lastMessage: event.message } : {}),
            };
        case 'tool.completed':
            return {
                toolId,
                status: 'completed',
                ...(current?.startedAt !== undefined ? { startedAt: current.startedAt } : {}),
                completedAt: event.timestamp,
                ...(event.message !== undefined ? { lastMessage: event.message } : {}),
            };
        case 'tool.failed':
            return {
                toolId,
                status: 'failed',
                ...(current?.startedAt !== undefined ? { startedAt: current.startedAt } : {}),
                failedAt: event.timestamp,
                ...(event.message !== undefined ? { lastMessage: event.message } : {}),
            };
        default:
            return undefined;
    }
}

function toolIdForEvent(event: AgentEvent): string | undefined {
    return event.abg?.nodeId ?? event.taskId;
}
