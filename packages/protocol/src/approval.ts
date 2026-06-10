import { z } from 'zod';

export const APPROVAL_POLICY_DECISIONS = ['allow', 'deny', 'requires_approval'] as const;

export const APPROVAL_LIFECYCLE_STATES = ['pending', 'approved', 'denied', 'expired', 'cancelled'] as const;

export const ApprovalPolicyDecisionSchema = z.enum(APPROVAL_POLICY_DECISIONS);
export type ApprovalPolicyDecision = z.infer<typeof ApprovalPolicyDecisionSchema>;

export const ApprovalLifecycleStateSchema = z.enum(APPROVAL_LIFECYCLE_STATES);
export type ApprovalLifecycleState = z.infer<typeof ApprovalLifecycleStateSchema>;

export const ApprovalSubjectSchema = z
    .object({
        kind: z.enum(['tool', 'graph', 'node', 'model', 'session']),
        id: z.string().min(1),
    })
    .strict();
export type ApprovalSubject = z.infer<typeof ApprovalSubjectSchema>;

export const ApprovalRecordSchema = z
    .object({
        approvalId: z.string().min(1),
        requestId: z.string().min(1),
        policyDecision: ApprovalPolicyDecisionSchema,
        state: ApprovalLifecycleStateSchema,
        subject: ApprovalSubjectSchema,
        requestedAt: z.string().datetime(),
        decidedAt: z.string().datetime().optional(),
        reason: z.string().min(1).optional(),
    })
    .strict()
    .superRefine((record, context) => {
        const isTerminal = record.state !== 'pending';

        if (record.policyDecision === 'allow') {
            context.addIssue({
                code: 'custom',
                message: 'allowed policy decisions must not create approval records',
                path: ['policyDecision'],
            });
        }

        if (record.policyDecision === 'deny' && record.state !== 'denied') {
            context.addIssue({
                code: 'custom',
                message: 'denied policy decisions must use denied approval state',
                path: ['state'],
            });
        }

        if (record.state === 'pending' && record.decidedAt !== undefined) {
            context.addIssue({
                code: 'custom',
                message: 'pending approvals must not have a decision timestamp',
                path: ['decidedAt'],
            });
        }

        if (isTerminal && record.decidedAt === undefined) {
            context.addIssue({
                code: 'custom',
                message: 'terminal approval states require a decision timestamp',
                path: ['decidedAt'],
            });
        }
    });
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
