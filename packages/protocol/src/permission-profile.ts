import { z } from 'zod';

export const PERMISSION_KINDS = ['read', 'edit', 'write', 'patch', 'bash'] as const;
export const PERMISSION_RULE_DECISIONS = ['ask', 'once', 'always', 'deny'] as const;
export const PERMISSION_REPLY_VALUES = ['once', 'always', 'deny'] as const;

export const PermissionKindSchema = z.enum(PERMISSION_KINDS);
export type PermissionKind = z.infer<typeof PermissionKindSchema>;

export const PermissionRuleDecisionSchema = z.enum(PERMISSION_RULE_DECISIONS);
export type PermissionRuleDecision = z.infer<typeof PermissionRuleDecisionSchema>;

export const PermissionReplyValueSchema = z.enum(PERMISSION_REPLY_VALUES);
export type PermissionReplyValue = z.infer<typeof PermissionReplyValueSchema>;

export const PermissionRuleSchema = z
    .object({
        permission: PermissionKindSchema,
        pattern: z.string().min(1),
        decision: PermissionRuleDecisionSchema,
        workspaceRoot: z.string().min(1).optional(),
    })
    .strict();
export type PermissionRule = z.infer<typeof PermissionRuleSchema>;

export const PermissionScopeSchema = z
    .object({
        kind: PermissionKindSchema,
        patterns: z.array(z.string().min(1)).min(1),
        workspaceRoot: z.string().min(1).optional(),
    })
    .strict();
export type PermissionScope = z.infer<typeof PermissionScopeSchema>;

export const PermissionRequestSchema = z
    .object({
        id: z.string().min(1),
        action: z.string().min(1),
        reason: z.string().min(1),
        permission: PermissionScopeSchema.optional(),
    })
    .strict();
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

export const PermissionDecisionSchema = z
    .object({
        requestId: z.string().min(1),
        status: z.enum(['allow', 'deny', 'requires_approval']),
        reason: z.string().optional(),
        matchedRule: PermissionRuleSchema.optional(),
    })
    .strict();
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const PermissionReplySchema = z
    .object({
        approvalId: z.string().min(1),
        reply: PermissionReplyValueSchema,
        reason: z.string().min(1).optional(),
        persist: z.boolean().optional(),
    })
    .strict();
export type PermissionReply = z.infer<typeof PermissionReplySchema>;
