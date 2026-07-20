import { z } from 'zod';
import { AbgNodeStatusSchema } from './abg-constants';

export const GRAPH_CHECKPOINT_REASONS = ['node_boundary', 'interrupt', 'approval_block'] as const;
export const GraphCheckpointReasonSchema = z.enum(GRAPH_CHECKPOINT_REASONS);
export type GraphCheckpointReason = z.infer<typeof GraphCheckpointReasonSchema>;

const GraphCheckpointCounterRecordSchema = z.record(z.string(), z.number().int().nonnegative());

export const GraphCheckpointSchema = z.object({
    schemaVersion: z.literal(1),
    graphId: z.string().min(1),
    sessionRunId: z.string().min(1).optional(),
    workflowName: z.string().min(1).optional(),
    reason: GraphCheckpointReasonSchema,
    queuedNodeIds: z.array(z.string().min(1)),
    completedNodeIds: z.array(z.string().min(1)),
    nodeStatuses: z.record(z.string(), AbgNodeStatusSchema),
    attemptsByNodeId: GraphCheckpointCounterRecordSchema,
    consecutiveFailuresByNodeId: GraphCheckpointCounterRecordSchema,
    consecutiveToolFailuresByNodeId: GraphCheckpointCounterRecordSchema,
    totalNodeRuns: z.number().int().nonnegative(),
    budgetExtensionsUsed: z.number().int().nonnegative(),
    maxNodeRuns: z.number().int().positive(),
    blackboardEntries: z.record(z.string(), z.unknown()),
    activeParallelParentIds: z.array(z.string().min(1)),
    createdAt: z.string().datetime(),
});
export type GraphCheckpoint = z.infer<typeof GraphCheckpointSchema>;
