import type { AbgNodeStatus, GraphCheckpoint } from '@mission-control/protocol';
import type { AuthorableAbgGraph } from './authorable-graph';

export const RESUME_INVALID_CHECKPOINT_CODE = 'resume_invalid_checkpoint' as const;

export class ResumeInvalidCheckpointError extends Error {
    readonly code = RESUME_INVALID_CHECKPOINT_CODE;

    constructor(readonly unknownNodeId: string) {
        super(`ABG resume checkpoint references unknown node: ${unknownNodeId}`);
        this.name = 'ResumeInvalidCheckpointError';
    }
}

export type HydratedResumeFields = {
    readonly queuedNodeIds: string[];
    readonly nodeStatuses: Record<string, AbgNodeStatus | undefined>;
    readonly attemptsByNodeId: Map<string, number>;
    readonly consecutiveFailuresByNodeId: Map<string, number>;
    readonly consecutiveToolFailuresByNodeId: Map<string, number>;
    readonly activeParallelParentIds: Set<string>;
    readonly totalNodeRuns: number;
    readonly budgetExtensionsUsed: number;
    readonly maxNodeRuns: number;
};

export function assertResumeQueuedNodesExist(graph: AuthorableAbgGraph, checkpoint: GraphCheckpoint): void {
    for (const nodeId of checkpoint.queuedNodeIds) {
        if (!graph.nodes.some((node) => node.id === nodeId)) {
            throw new ResumeInvalidCheckpointError(nodeId);
        }
    }
}

export function hydrateResumeFields(checkpoint: GraphCheckpoint): HydratedResumeFields {
    // Drop succeeded ids from the resume cursor only. Live runs may re-queue a just-succeeded
    // node (self-edge loop, dead-end re-admit); that path must keep scheduling.
    const queuedNodeIds = checkpoint.queuedNodeIds.filter((nodeId) => checkpoint.nodeStatuses[nodeId] !== 'succeeded');
    return {
        queuedNodeIds,
        nodeStatuses: { ...checkpoint.nodeStatuses },
        attemptsByNodeId: counterMapFromRecord(checkpoint.attemptsByNodeId),
        consecutiveFailuresByNodeId: counterMapFromRecord(checkpoint.consecutiveFailuresByNodeId),
        consecutiveToolFailuresByNodeId: counterMapFromRecord(checkpoint.consecutiveToolFailuresByNodeId),
        activeParallelParentIds: new Set(checkpoint.activeParallelParentIds),
        totalNodeRuns: checkpoint.totalNodeRuns,
        budgetExtensionsUsed: checkpoint.budgetExtensionsUsed,
        maxNodeRuns: checkpoint.maxNodeRuns,
    };
}

function counterMapFromRecord(record: Readonly<Record<string, number>>): Map<string, number> {
    return new Map(Object.entries(record));
}
