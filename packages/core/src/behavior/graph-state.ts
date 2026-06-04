import {
    type AbgGraphSnapshot,
    AbgGraphSnapshotSchema,
    type AbgGraphStatus,
    type AbgNodeSnapshot,
    type AbgNodeStatus,
    type AgentEvent,
} from '@mission-control/protocol';

export function deriveAbgGraphSnapshot(events: readonly AgentEvent[], graphId: string): AbgGraphSnapshot {
    const nodes = new Map<string, AbgNodeSnapshot>();
    let status: AbgGraphStatus = 'created';

    for (const event of events) {
        if (event.abg?.graphId !== graphId) {
            continue;
        }
        status = graphStatusForEvent(event.type, status);
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
    });
}

function graphStatusForEvent(eventType: AgentEvent['type'], current: AbgGraphStatus): AbgGraphStatus {
    switch (eventType) {
        case 'graph.started':
            return 'active';
        case 'graph.completed':
            return 'completed';
        case 'graph.failed':
            return 'failed';
        case 'graph.cancelled':
            return 'cancelled';
        case 'policy.blocked':
            return current === 'completed' ? current : 'blocked';
        default:
            return current;
    }
}

function nodeStatusForEvent(eventType: AgentEvent['type']): AbgNodeStatus | undefined {
    switch (eventType) {
        case 'node.started':
        case 'node.progress':
        case 'decision.selected':
        case 'workflow.transitioned':
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
