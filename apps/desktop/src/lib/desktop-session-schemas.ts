import type { AgentEventEnvelope, SessionAwaitingDetails, SessionStatus } from '@mission-control/protocol';
import { AgentEventEnvelopeSchema, SessionAwaitingDetailsSchema, SessionStatusSchema } from '@mission-control/protocol';
import { z } from 'zod';

export const DESKTOP_SESSION_STATES = ['available', 'empty', 'missing', 'corrupt'] as const;
export const DesktopSessionStateSchema = z.enum(DESKTOP_SESSION_STATES);
export type DesktopSessionState = z.infer<typeof DesktopSessionStateSchema>;

export const DESKTOP_SESSION_LOCK_STATES = ['none', 'live', 'stale', 'corrupt'] as const;
export const DesktopSessionLockStateSchema = z.enum(DESKTOP_SESSION_LOCK_STATES);
export type DesktopSessionLockState = z.infer<typeof DesktopSessionLockStateSchema>;

export const DesktopSessionDiagnosticSchema = z
    .object({
        code: z.string().min(1),
        message: z.string().min(1),
        lineNumber: z.number().int().positive().optional(),
    })
    .strict();
export type DesktopSessionDiagnostic = z.infer<typeof DesktopSessionDiagnosticSchema>;

export const DESKTOP_WORKSPACE_TRUST_STATES = ['trusted', 'denied', 'unknown'] as const;
export const DesktopWorkspaceTrustStateSchema = z.enum(DESKTOP_WORKSPACE_TRUST_STATES);
export type DesktopWorkspaceTrustState = z.infer<typeof DesktopWorkspaceTrustStateSchema>;

export const DesktopSessionTreeSummarySchema = z
    .object({
        sessionName: z.string().min(1).optional(),
        cwd: z.string().min(1).optional(),
        trustedRoot: z.string().min(1).optional(),
        workspaceTrust: DesktopWorkspaceTrustStateSchema.optional(),
        parentSessionId: z.string().min(1).optional(),
        activeLeafId: z.string().min(1).optional(),
        entryCount: z.number().int().nonnegative(),
        branchCount: z.number().int().nonnegative(),
        forkSourceSessionId: z.string().min(1).optional(),
        cloneSourceSessionId: z.string().min(1).optional(),
    })
    .strict();
export type DesktopSessionTreeSummary = z.infer<typeof DesktopSessionTreeSummarySchema>;

export const DesktopSessionStatsSchema = z
    .object({
        eventCount: z.number().int().nonnegative(),
        pendingApprovalCount: z.number().int().nonnegative(),
        blockedRunCount: z.number().int().nonnegative(),
        commandEventCount: z.number().int().nonnegative(),
        diffEventCount: z.number().int().nonnegative(),
        toolOutcomeCount: z.number().int().nonnegative(),
    })
    .strict();
export type DesktopSessionStats = z.infer<typeof DesktopSessionStatsSchema>;

const DesktopSessionLifecycleShape = {
    status: SessionStatusSchema.optional(),
    statusText: z.string().min(1).optional(),
    awaiting: SessionAwaitingDetailsSchema.optional(),
} as const;

type DesktopSessionLifecycleFields = {
    readonly status?: SessionStatus | undefined;
    readonly awaiting?: SessionAwaitingDetails | undefined;
};

function refineDesktopSessionLifecycle(value: DesktopSessionLifecycleFields, context: z.RefinementCtx): void {
    if (value.status === undefined) {
        if (value.awaiting !== undefined) {
            context.addIssue({
                code: 'custom',
                message: 'awaiting details require a session lifecycle status',
                path: ['awaiting'],
            });
        }
        return;
    }
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

export const DesktopSessionSummarySchema = z
    .object({
        sessionId: z.string().min(1),
        fileName: z.string().min(1),
        state: DesktopSessionStateSchema,
        ...DesktopSessionLifecycleShape,
        eventCount: z.number().int().nonnegative(),
        lockState: DesktopSessionLockStateSchema.optional(),
        indexed: z.boolean().optional(),
        updatedAt: z.string().min(1).optional(),
        diagnostics: z.array(DesktopSessionDiagnosticSchema),
        sessionTree: DesktopSessionTreeSummarySchema.optional(),
        stats: DesktopSessionStatsSchema.optional(),
    })
    .strict()
    .superRefine(refineDesktopSessionLifecycle);
export const DesktopSessionSummaryListSchema = z.array(DesktopSessionSummarySchema);
export type DesktopSessionSummary = z.infer<typeof DesktopSessionSummarySchema>;

const RawDesktopSessionLogSchema = z
    .object({
        sessionId: z.string().min(1),
        state: DesktopSessionStateSchema,
        contents: z.string(),
        envelopes: z.array(z.unknown()),
        diagnostics: z.array(DesktopSessionDiagnosticSchema),
    })
    .strict();

export const DesktopSessionLogSchema = z
    .object({
        sessionId: z.string().min(1),
        state: DesktopSessionStateSchema,
        contents: z.string(),
        envelopes: z.array(AgentEventEnvelopeSchema),
        diagnostics: z.array(DesktopSessionDiagnosticSchema),
    })
    .strict();
export type DesktopSessionLog = z.infer<typeof DesktopSessionLogSchema>;

export const DesktopSessionSnapshotSchema = z
    .object({
        sessionId: z.string().min(1),
        state: DesktopSessionStateSchema,
        ...DesktopSessionLifecycleShape,
        eventCount: z.number().int().nonnegative(),
        graphIds: z.array(z.string().min(1)),
        lockState: DesktopSessionLockStateSchema.optional(),
        indexed: z.boolean().optional(),
        updatedAt: z.string().min(1).optional(),
        diagnostics: z.array(DesktopSessionDiagnosticSchema),
        sessionTree: DesktopSessionTreeSummarySchema.optional(),
        stats: DesktopSessionStatsSchema.optional(),
    })
    .strict()
    .superRefine(refineDesktopSessionLifecycle);
export type DesktopSessionSnapshot = z.infer<typeof DesktopSessionSnapshotSchema>;

export function parseDesktopSessionLogPayload(payload: unknown): DesktopSessionLog {
    const raw = RawDesktopSessionLogSchema.parse(payload);
    const diagnostics: DesktopSessionDiagnostic[] = [...raw.diagnostics];
    const envelopes: DesktopSessionLog['envelopes'] = [];
    let previousSequence = -1;
    const seenEventIds = new Set<string>();
    for (const [index, envelope] of raw.envelopes.entries()) {
        const lineNumber = index + 2;
        const parsedEnvelope = AgentEventEnvelopeSchema.safeParse(envelope);
        if (!parsedEnvelope.success) {
            diagnostics.push({
                code: 'corrupt_envelope',
                message: 'event envelope failed protocol validation',
                lineNumber,
            });
            break;
        }
        const invariantDiagnostic = logInvariantDiagnostic(
            parsedEnvelope.data,
            raw.sessionId,
            previousSequence,
            seenEventIds,
            lineNumber,
        );
        if (invariantDiagnostic !== undefined) {
            diagnostics.push(invariantDiagnostic);
            break;
        }
        previousSequence = parsedEnvelope.data.sequence;
        seenEventIds.add(parsedEnvelope.data.eventId);
        envelopes.push(parsedEnvelope.data);
    }
    let state: DesktopSessionState = raw.state;
    if (state === 'available' && diagnostics.length > raw.diagnostics.length) {
        state = 'corrupt';
    }
    return {
        sessionId: raw.sessionId,
        state,
        contents: raw.contents,
        envelopes,
        diagnostics,
    };
}

function logInvariantDiagnostic(
    envelope: AgentEventEnvelope,
    sessionId: string,
    previousSequence: number,
    seenEventIds: ReadonlySet<string>,
    lineNumber: number,
): DesktopSessionDiagnostic | undefined {
    if (envelope.sessionId !== sessionId || envelope.event.sessionId !== sessionId) {
        return {
            code: 'session_mismatch',
            message: 'event envelope belongs to another session',
            lineNumber,
        };
    }
    if (envelope.durability !== 'durable') {
        return {
            code: 'corrupt_envelope',
            message: 'event envelope is not durable',
            lineNumber,
        };
    }
    if (envelope.sequence <= previousSequence) {
        return {
            code: 'corrupt_envelope',
            message: 'event sequence is not strictly increasing',
            lineNumber,
        };
    }
    if (seenEventIds.has(envelope.eventId)) {
        return {
            code: 'corrupt_envelope',
            message: 'event id is duplicated',
            lineNumber,
        };
    }
    return undefined;
}
