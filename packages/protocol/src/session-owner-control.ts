import { z } from 'zod';
import {
    SessionAbortAffectedCountsSchema,
    SessionStopBarrierKindSchema,
    SessionStopErrorCodeSchema,
    SessionStopOutcomeSchema,
} from './session-stop';

export const SESSION_OWNER_CONTROL_PROTOCOL_VERSION = 1 as const;
export const SESSION_OWNER_CONTROL_TOKEN_KIND = 'exact_session_stop' as const;
export const SESSION_OWNER_CONTROL_ERROR_CODES = [
    'invalid_request',
    'authentication_failed',
    'ownerless',
    'owner_unreachable',
    'owner_fenced',
    'token_invalid',
    'internal_error',
] as const;

export const SessionStopReceiptSchema = z
    .object({
        outcome: SessionStopOutcomeSchema,
        requestId: z.string().min(1),
        operationId: z.string().min(1),
        affected: SessionAbortAffectedCountsSchema,
        errorCode: SessionStopErrorCodeSchema.optional(),
    })
    .strict();
export type SessionStopReceiptContract = z.infer<typeof SessionStopReceiptSchema>;

export const SessionOwnerControlTokenSchema = z
    .object({
        value: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
        operationId: z.string().min(1),
        sessionId: z.string().min(1),
        kind: z.literal(SESSION_OWNER_CONTROL_TOKEN_KIND),
        ownerId: z.string().min(1),
        ownerEpoch: z.number().int().positive(),
        timeoutMs: z.number().int().nonnegative(),
    })
    .strict();
export type SessionOwnerControlToken = z.infer<typeof SessionOwnerControlTokenSchema>;

const requestBase = { version: z.literal(SESSION_OWNER_CONTROL_PROTOCOL_VERSION), id: z.string().min(1) } as const;
export const SessionOwnerControlAcquireRequestSchema = z
    .object({
        ...requestBase,
        method: z.literal('session.acquire'),
        params: z
            .object({
                sessionId: z.string().min(1),
                requestId: z.string().min(1),
                operationId: z.string().min(1),
                kind: z.literal(SESSION_OWNER_CONTROL_TOKEN_KIND),
                barrierKind: SessionStopBarrierKindSchema.optional(),
                timeoutMs: z.number().int().nonnegative(),
            })
            .strict(),
    })
    .strict();
export const SessionOwnerControlStopRequestSchema = z
    .object({
        ...requestBase,
        method: z.literal('session.stop'),
        params: z.object({ token: SessionOwnerControlTokenSchema }).strict(),
    })
    .strict();
export const SessionOwnerControlReleaseRequestSchema = z
    .object({
        ...requestBase,
        method: z.literal('session.release'),
        params: z.object({ token: SessionOwnerControlTokenSchema }).strict(),
    })
    .strict();
export const SessionOwnerControlRequestSchema = z.discriminatedUnion('method', [
    SessionOwnerControlAcquireRequestSchema,
    SessionOwnerControlStopRequestSchema,
    SessionOwnerControlReleaseRequestSchema,
]);
export type SessionOwnerControlRequest = z.infer<typeof SessionOwnerControlRequestSchema>;

const responseBase = { version: z.literal(SESSION_OWNER_CONTROL_PROTOCOL_VERSION), id: z.string().min(1) } as const;
export const SessionOwnerControlSuccessResponseSchema = z
    .object({ ...responseBase, ok: z.literal(true), result: z.unknown() })
    .strict();
export const SessionOwnerControlErrorCodeSchema = z.enum(SESSION_OWNER_CONTROL_ERROR_CODES);
export type SessionOwnerControlErrorCode = z.infer<typeof SessionOwnerControlErrorCodeSchema>;
export const SessionOwnerControlErrorResponseSchema = z
    .object({
        ...responseBase,
        ok: z.literal(false),
        error: z.object({ code: SessionOwnerControlErrorCodeSchema, message: z.string().min(1) }).strict(),
    })
    .strict();
export const SessionOwnerControlResponseSchema = z.union([
    SessionOwnerControlSuccessResponseSchema,
    SessionOwnerControlErrorResponseSchema,
]);
export type SessionOwnerControlResponse = z.infer<typeof SessionOwnerControlResponseSchema>;

export const SessionOwnerControlAcquireResultSchema = z.object({ token: SessionOwnerControlTokenSchema }).strict();
export const SessionOwnerControlReleaseResultSchema = z.object({ released: z.boolean() }).strict();
