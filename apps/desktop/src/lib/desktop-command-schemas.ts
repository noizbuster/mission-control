import { type ApprovalRecord, type ModelProviderSelection, RUN_COORDINATOR_STATES } from '@mission-control/protocol';
import { z } from 'zod';

export type DesktopApprovalDecisionState = Extract<
    ApprovalRecord['state'],
    'approved' | 'denied' | 'expired' | 'cancelled'
>;

export type DesktopPromptCommandInput = {
    readonly sessionId: string;
    readonly prompt: string;
    readonly modelProviderSelection?: ModelProviderSelection;
    readonly parentMessageId?: string;
    readonly resume?: boolean;
};

export type DesktopRunCommandInput = {
    readonly sessionId: string;
    readonly reason?: string;
};

export type DesktopApprovalDecisionInput = {
    readonly sessionId: string;
    readonly approvalId: string;
    readonly state: DesktopApprovalDecisionState;
    readonly reason?: string;
};

export const DESKTOP_APPROVAL_EFFECT_OUTCOMES = ['completed', 'failed'] as const;
export const DesktopApprovalEffectOutcomeSchema = z.enum(DESKTOP_APPROVAL_EFFECT_OUTCOMES);
export type DesktopApprovalEffectOutcome = z.infer<typeof DesktopApprovalEffectOutcomeSchema>;

export const DesktopApprovalEffectQueryInputSchema = z
    .object({
        sessionId: z.string().min(1),
        approvalId: z.string().min(1),
    })
    .strict();
export type DesktopApprovalEffectQueryInput = z.infer<typeof DesktopApprovalEffectQueryInputSchema>;

export const DesktopApprovalEffectResolutionInputSchema = DesktopApprovalEffectQueryInputSchema.extend({
    outcome: DesktopApprovalEffectOutcomeSchema,
}).strict();
export type DesktopApprovalEffectResolutionInput = z.infer<typeof DesktopApprovalEffectResolutionInputSchema>;

export const DesktopApprovalEffectIdentitySchema = z
    .object({
        sessionId: z.string().min(1),
        approvalId: z.string().min(1),
        runId: z.string().min(1),
        toolCallId: z.string().min(1),
        toolName: z.string().min(1),
        argumentsJson: z.string(),
        workspaceRoot: z.string().min(1),
    })
    .strict();
export type DesktopApprovalEffectIdentity = z.infer<typeof DesktopApprovalEffectIdentitySchema>;

const DesktopApprovalEffectRecordBaseSchema = z.object({
    effect: DesktopApprovalEffectIdentitySchema,
    requestedAt: z.string().min(1),
});

export const DesktopApprovalEffectRecordSchema = z.union([
    DesktopApprovalEffectRecordBaseSchema.extend({ state: z.literal('pending') }).strict(),
    DesktopApprovalEffectRecordBaseSchema.extend({
        state: z.literal('executing'),
        executionToken: z.string().min(1),
        leaseExpiresAt: z.string().min(1),
        executingAt: z.string().min(1),
    }).strict(),
    DesktopApprovalEffectRecordBaseSchema.extend({
        state: z.literal('settled'),
        executionToken: z.string().min(1),
        leaseExpiresAt: z.string().min(1),
        executingAt: z.string().min(1),
        outcome: DesktopApprovalEffectOutcomeSchema,
        settledAt: z.string().min(1),
    }).strict(),
    DesktopApprovalEffectRecordBaseSchema.extend({
        state: z.literal('unknown'),
        executionToken: z.string().min(1),
        leaseExpiresAt: z.string().min(1),
        executingAt: z.string().min(1),
        unknownAt: z.string().min(1),
    }).strict(),
    DesktopApprovalEffectRecordBaseSchema.extend({
        state: z.literal('unknown'),
        executionToken: z.string().min(1),
        leaseExpiresAt: z.string().min(1),
        executingAt: z.string().min(1),
        unknownAt: z.string().min(1),
        outcome: DesktopApprovalEffectOutcomeSchema,
        resolvedAt: z.string().min(1),
    }).strict(),
]);
export type DesktopApprovalEffectRecord = z.infer<typeof DesktopApprovalEffectRecordSchema>;
export type DesktopUnresolvedUnknownApprovalEffect = Extract<
    DesktopApprovalEffectRecord,
    { readonly state: 'unknown' }
>;

export function isUnresolvedUnknownApprovalEffect(
    record: DesktopApprovalEffectRecord,
): record is DesktopUnresolvedUnknownApprovalEffect {
    return record.state === 'unknown' && !('outcome' in record);
}

export const DesktopApprovalEffectResolutionReceiptSchema = z.union([
    z
        .object({
            sessionId: z.string().min(1),
            status: z.literal('resolved'),
            effect: DesktopApprovalEffectRecordSchema,
        })
        .strict(),
    z
        .object({
            sessionId: z.string().min(1),
            status: z.literal('idle'),
        })
        .strict(),
]);
export type DesktopApprovalEffectResolutionReceipt = z.infer<typeof DesktopApprovalEffectResolutionReceiptSchema>;

export const DESKTOP_COMMAND_RECEIPT_STATUSES = ['queued', 'blocked', ...RUN_COORDINATOR_STATES] as const;

export const DesktopCommandReceiptSchema = z
    .object({
        sessionId: z.string().min(1),
        status: z.enum(DESKTOP_COMMAND_RECEIPT_STATUSES),
        eventsWritten: z.number().int().nonnegative(),
    })
    .strict();
export type DesktopCommandReceipt = z.infer<typeof DesktopCommandReceiptSchema>;
