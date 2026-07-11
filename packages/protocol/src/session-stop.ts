import { z } from 'zod';

export const SESSION_STOP_REASONS = ['operator_aborted'] as const;
export const SESSION_STOP_SCOPES = ['tree', 'only', 'children'] as const;
export const SESSION_STOP_BARRIER_KINDS = ['all_mutations', 'child_spawn_only'] as const;
export const SESSION_STOP_OUTCOMES = ['interrupted', 'already_idle', 'already_terminal', 'failed'] as const;
export const SESSION_STOP_ERROR_CODES = [
    'session_not_found',
    'session_owned_elsewhere',
    'owner_unreachable',
    'session_stopping',
    'stop_timeout',
    'unstable_session_tree',
] as const;

export const SessionStopReasonSchema = z.enum(SESSION_STOP_REASONS);
export type SessionStopReason = z.infer<typeof SessionStopReasonSchema>;

export const SessionStopScopeSchema = z.enum(SESSION_STOP_SCOPES);
export type SessionStopScope = z.infer<typeof SessionStopScopeSchema>;

export const SessionStopBarrierKindSchema = z.enum(SESSION_STOP_BARRIER_KINDS);
export type SessionStopBarrierKind = z.infer<typeof SessionStopBarrierKindSchema>;

export const SessionStopOutcomeSchema = z.enum(SESSION_STOP_OUTCOMES);
export type SessionStopOutcome = z.infer<typeof SessionStopOutcomeSchema>;

export const SessionStopErrorCodeSchema = z.enum(SESSION_STOP_ERROR_CODES);
export type SessionStopErrorCode = z.infer<typeof SessionStopErrorCodeSchema>;

export const SessionAbortAffectedCountsSchema = z
    .object({
        runs: z.number().int().nonnegative(),
        approvals: z.number().int().nonnegative(),
        sessionAwaits: z.number().int().nonnegative(),
        sessionInputs: z.number().int().nonnegative(),
        missionRuns: z.number().int().nonnegative(),
        asyncJobs: z.number().int().nonnegative(),
        toolCalls: z.number().int().nonnegative(),
    })
    .strict();
export type SessionAbortAffectedCounts = z.infer<typeof SessionAbortAffectedCountsSchema>;

export const SessionAbortCompletedMetadataSchema = z
    .object({
        operationId: z.string().min(1),
        requestId: z.string().min(1),
        reason: SessionStopReasonSchema,
        affected: SessionAbortAffectedCountsSchema,
    })
    .strict();
export type SessionAbortCompletedMetadata = z.infer<typeof SessionAbortCompletedMetadataSchema>;
