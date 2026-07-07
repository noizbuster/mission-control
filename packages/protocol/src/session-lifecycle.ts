import { z } from 'zod';

export const SESSION_STATUSES = ['idle', 'running', 'awaiting', 'stopped', 'failed'] as const;

export const SESSION_AWAITING_REASONS = ['approval', 'user_input', 'subagent'] as const;

export const SessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionAwaitingReasonSchema = z.enum(SESSION_AWAITING_REASONS);
export type SessionAwaitingReason = z.infer<typeof SessionAwaitingReasonSchema>;

const SessionAwaitingIdSchema = z.string().min(1);

const SessionRunToolSourceShape = {
    runId: SessionAwaitingIdSchema.optional(),
    toolCallId: SessionAwaitingIdSchema.optional(),
} as const;

export const SessionAwaitingSourceSchema = z
    .object({
        approvalId: SessionAwaitingIdSchema.optional(),
        inputId: SessionAwaitingIdSchema.optional(),
        runId: SessionAwaitingIdSchema.optional(),
        toolCallId: SessionAwaitingIdSchema.optional(),
        jobId: SessionAwaitingIdSchema.optional(),
        childSessionId: SessionAwaitingIdSchema.optional(),
    })
    .strict();
export type SessionAwaitingSource = z.infer<typeof SessionAwaitingSourceSchema>;

const ApprovalAwaitingSourceSchema = z
    .object({
        ...SessionRunToolSourceShape,
        inputId: z.never().optional(),
        approvalId: SessionAwaitingIdSchema,
        jobId: z.never().optional(),
        childSessionId: z.never().optional(),
    })
    .strict();

const UserInputAwaitingSourceSchema = z
    .object({
        ...SessionRunToolSourceShape,
        inputId: SessionAwaitingIdSchema.optional(),
        approvalId: z.never().optional(),
        jobId: z.never().optional(),
        childSessionId: z.never().optional(),
    })
    .strict();

const SubagentAwaitingSourceSchema = z
    .object({
        ...SessionRunToolSourceShape,
        inputId: z.never().optional(),
        approvalId: z.never().optional(),
        jobId: SessionAwaitingIdSchema.optional(),
        childSessionId: SessionAwaitingIdSchema.optional(),
    })
    .strict()
    .refine((source) => source.jobId !== undefined || source.childSessionId !== undefined, {
        message: 'subagent awaiting source requires jobId or childSessionId',
        path: ['jobId'],
    });

export const SessionAwaitingDetailsSchema = z.discriminatedUnion('reason', [
    z
        .object({
            reason: z.literal('approval'),
            source: ApprovalAwaitingSourceSchema,
        })
        .strict(),
    z
        .object({
            reason: z.literal('user_input'),
            source: UserInputAwaitingSourceSchema,
        })
        .strict(),
    z
        .object({
            reason: z.literal('subagent'),
            source: SubagentAwaitingSourceSchema,
        })
        .strict(),
]);
export type SessionAwaitingDetails = z.infer<typeof SessionAwaitingDetailsSchema>;

type SessionLifecycleFields = {
    readonly status: SessionStatus;
    readonly awaiting?: SessionAwaitingDetails | undefined;
};

export function refineSessionAwaitingContract(value: SessionLifecycleFields, context: z.RefinementCtx): void {
    if (value.status === 'awaiting') {
        if (value.awaiting === undefined) {
            context.addIssue({
                code: 'custom',
                message: 'awaiting session status requires awaiting details',
                path: ['awaiting'],
            });
        }
        return;
    }

    if (value.awaiting !== undefined) {
        context.addIssue({
            code: 'custom',
            message: 'awaiting details require awaiting session status',
            path: ['awaiting'],
        });
    }
}
