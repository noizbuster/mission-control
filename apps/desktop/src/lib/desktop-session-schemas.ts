import type { AgentEventEnvelope } from '@mission-control/protocol';
import { AgentEventEnvelopeSchema } from '@mission-control/protocol';
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

export const DesktopSessionSummarySchema = z
    .object({
        sessionId: z.string().min(1),
        fileName: z.string().min(1),
        state: DesktopSessionStateSchema,
        eventCount: z.number().int().nonnegative(),
        lockState: DesktopSessionLockStateSchema.optional(),
        indexed: z.boolean().optional(),
        updatedAt: z.string().min(1).optional(),
        diagnostics: z.array(DesktopSessionDiagnosticSchema),
    })
    .strict();
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
        eventCount: z.number().int().nonnegative(),
        graphIds: z.array(z.string().min(1)),
        lockState: DesktopSessionLockStateSchema.optional(),
        indexed: z.boolean().optional(),
        updatedAt: z.string().min(1).optional(),
        diagnostics: z.array(DesktopSessionDiagnosticSchema),
    })
    .strict();
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
