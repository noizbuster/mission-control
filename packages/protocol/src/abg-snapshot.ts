import { z } from 'zod';
import { AbgGraphStatusSchema, AbgNodeStatusSchema } from './abg-constants.js';
import { AbgSignalSchema, AbgSignalTypeSchema } from './abg-signal.js';
import { ApprovalRecordSchema } from './approval.js';

export const ABG_TOOL_OUTCOME_STATUSES = ['started', 'completed', 'failed'] as const;
export const AbgToolOutcomeStatusSchema = z.enum(ABG_TOOL_OUTCOME_STATUSES);
export type AbgToolOutcomeStatus = z.infer<typeof AbgToolOutcomeStatusSchema>;

export const AbgBlackboardEntrySchema = z.object({
    key: z.string().min(1),
    value: z.unknown(),
    updatedAt: z.string().datetime().optional(),
});
export type AbgBlackboardEntry = z.infer<typeof AbgBlackboardEntrySchema>;

export const AbgNodeSnapshotSchema = z.object({
    nodeId: z.string().min(1),
    status: AbgNodeStatusSchema,
    lastSignalType: AbgSignalTypeSchema.optional(),
});
export type AbgNodeSnapshot = z.infer<typeof AbgNodeSnapshotSchema>;

export const AbgToolOutcomeSnapshotSchema = z.object({
    toolId: z.string().min(1),
    status: AbgToolOutcomeStatusSchema,
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    failedAt: z.string().datetime().optional(),
    lastMessage: z.string().optional(),
});
export type AbgToolOutcomeSnapshot = z.infer<typeof AbgToolOutcomeSnapshotSchema>;

export const AbgGraphSnapshotSchema = z.object({
    graphId: z.string().min(1),
    status: AbgGraphStatusSchema,
    activeNodeIds: z.array(z.string().min(1)).default([]),
    nodes: z.array(AbgNodeSnapshotSchema),
    blackboard: z.array(AbgBlackboardEntrySchema).default([]),
    approvals: z.array(ApprovalRecordSchema).default([]),
    toolOutcomes: z.array(AbgToolOutcomeSnapshotSchema).default([]),
    lastSignal: AbgSignalSchema.optional(),
});
export type AbgGraphSnapshot = z.infer<typeof AbgGraphSnapshotSchema>;
