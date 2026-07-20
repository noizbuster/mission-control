import { GraphCheckpointSchema, type AbgNodeStatus, type AgentEvent, type GraphCheckpointReason } from '@mission-control/protocol';
import { buildCheckpointBlackboardEntries } from './checkpoint-blackboard-snapshot';
import type { CoordinatorState } from './graph-coordinator-helpers';
import type { AbgGraphRunnerInput } from './graph-runner';

type EmitGraphCheckpointInput = {
    readonly graphId: string;
    readonly input: AbgGraphRunnerInput;
    readonly state: CoordinatorState;
    readonly reason: GraphCheckpointReason;
};

/**
 * Accepted v1 limits: checkpoints capture coordinator queue/counter state plus Blackboard entries
 * only. Token deltas, model message history, and resume-time node skipping remain outside this
 * builder; the checkpoint consumer owns those later resume policies.
 */
export function emitGraphCheckpoint(input: EmitGraphCheckpointInput): void {
    const createdAt = input.input.now();
    const nodeStatuses = nodeStatusRecord(input.state.nodeStatuses);
    const checkpoint = GraphCheckpointSchema.parse({
        schemaVersion: 1,
        graphId: input.graphId,
        ...(input.input.sessionRunId !== undefined ? { sessionRunId: input.input.sessionRunId } : {}),
        ...(input.input.workflowName !== undefined ? { workflowName: input.input.workflowName } : {}),
        reason: input.reason,
        queuedNodeIds: [...input.state.queuedNodeIds],
        completedNodeIds: completedNodeIds(nodeStatuses),
        nodeStatuses,
        attemptsByNodeId: counterRecord(input.state.attemptsByNodeId),
        consecutiveFailuresByNodeId: counterRecord(input.state.consecutiveFailuresByNodeId),
        consecutiveToolFailuresByNodeId: counterRecord(input.state.consecutiveToolFailuresByNodeId),
        totalNodeRuns: input.state.totalNodeRuns,
        budgetExtensionsUsed: input.state.budgetExtensionsUsed,
        maxNodeRuns: input.state.maxNodeRuns,
        blackboardEntries: buildCheckpointBlackboardEntries(input.state.blackboard.toRecord()),
        activeParallelParentIds: activeParallelParentIds(input.state),
        createdAt,
    });
    const event: AgentEvent = {
        type: 'graph.checkpoint',
        timestamp: createdAt,
        sessionId: input.input.sessionId,
        message: `graph checkpoint: ${input.reason}`,
        durability: 'durable',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: input.input.modelProviderSelection,
        abg: { graphId: input.graphId, checkpoint },
    };
    input.state.events.push(event);
}

export function requeueInterruptedNodesForCheckpoint(state: CoordinatorState): void {
    const interruptedNodeIds = interruptedResumeNodeIds(state);
    for (let index = interruptedNodeIds.length - 1; index >= 0; index -= 1) {
        const nodeId = interruptedNodeIds[index];
        if (nodeId !== undefined && !state.queuedNodeIds.includes(nodeId)) {
            state.queuedNodeIds.unshift(nodeId);
        }
    }
}

function nodeStatusRecord(statuses: CoordinatorState['nodeStatuses']): Record<string, AbgNodeStatus> {
    const record: Record<string, AbgNodeStatus> = {};
    for (const [nodeId, status] of Object.entries(statuses)) {
        if (status !== undefined) {
            record[nodeId] = status;
        }
    }
    return record;
}

function completedNodeIds(statuses: Readonly<Record<string, AbgNodeStatus>>): readonly string[] {
    return Object.entries(statuses)
        .filter((entry) => entry[1] === 'succeeded')
        .map((entry) => entry[0]);
}

function counterRecord(values: ReadonlyMap<string, number>): Record<string, number> {
    const record: Record<string, number> = {};
    for (const [nodeId, value] of values.entries()) {
        record[nodeId] = value;
    }
    return record;
}

function activeParallelParentIds(state: CoordinatorState): readonly string[] {
    return [...state.activeParallelParentIds].filter((nodeId) => state.nodeStatuses[nodeId] !== 'succeeded');
}

function interruptedResumeNodeIds(state: CoordinatorState): readonly string[] {
    const nodeIds: string[] = [];
    for (const nodeId of state.activeParallelParentIds) {
        pushInterruptedNodeId(nodeIds, nodeId, state);
    }
    for (const nodeId of state.activeNodeIds) {
        pushInterruptedNodeId(nodeIds, nodeId, state);
    }
    return nodeIds;
}

function pushInterruptedNodeId(nodeIds: string[], nodeId: string, state: CoordinatorState): void {
    if (state.nodeStatuses[nodeId] === 'succeeded' || nodeIds.includes(nodeId)) {
        return;
    }
    nodeIds.push(nodeId);
}
