import {
    AgentEventTypeSchema,
    ApprovalSubjectSchema,
    ProtocolErrorCodeSchema,
    ProtocolErrorSchema,
    RunCoordinatorCommandSchema,
    RunCoordinatorStateSchema,
    SESSION_STATUSES,
    ToolResultSchema,
} from '@mission-control/protocol';
import { z } from 'zod';
import { JSONL_SESSION_EVENT_STORE_ERROR_CODES } from './jsonl-errors.js';
import type { SessionIndexDiagnostic, SessionIndexRecord } from './session-index-types.js';

export const SESSION_INDEX_FILE_VERSION = 1;
export const SESSION_INDEX_TOOL_STATUSES = ['started', 'completed', 'failed'] as const;
export const SESSION_INDEX_DIAGNOSTIC_CODES = [...JSONL_SESSION_EVENT_STORE_ERROR_CODES, 'unknown'] as const;

const SourceFilePathSchema = z.string().min(1);
const SessionIdSchema = z.string().min(1);
const EventIdSchema = z.string().min(1);
const TimestampSchema = z.iso.datetime();

export const SessionIndexSessionRecordSchema = z
    .object({
        kind: z.literal('session'),
        sessionId: SessionIdSchema,
        status: z.enum(SESSION_STATUSES),
        startedAt: TimestampSchema,
        stoppedAt: TimestampSchema.optional(),
        eventCount: z.number().int().nonnegative(),
        lastSequence: z.number().int().nonnegative().optional(),
        lastEventId: EventIdSchema.optional(),
        lastEventType: AgentEventTypeSchema.optional(),
        updatedAt: TimestampSchema,
        sourceFilePath: SourceFilePathSchema,
    })
    .strict();

export const SessionIndexRunRecordSchema = z
    .object({
        kind: z.literal('run'),
        sessionId: SessionIdSchema,
        eventId: EventIdSchema,
        sequence: z.number().int().nonnegative(),
        timestamp: TimestampSchema,
        eventType: AgentEventTypeSchema,
        command: RunCoordinatorCommandSchema.optional(),
        state: RunCoordinatorStateSchema.optional(),
        runId: z.string().min(1).optional(),
        inputId: z.string().min(1).optional(),
        providerTurnId: z.string().min(1).optional(),
        reason: z.string().min(1).optional(),
        errorCode: ProtocolErrorCodeSchema.optional(),
    })
    .strict();

export const SessionIndexApprovalRecordSchema = z
    .object({
        kind: z.literal('approval'),
        sessionId: SessionIdSchema,
        approvalId: z.string().min(1),
        eventId: EventIdSchema,
        state: z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled']),
        subject: ApprovalSubjectSchema,
        requestedAt: TimestampSchema,
        decidedAt: TimestampSchema.optional(),
        updatedAt: TimestampSchema,
    })
    .strict();

export const SessionIndexToolRecordSchema = z
    .object({
        kind: z.literal('tool'),
        sessionId: SessionIdSchema,
        toolId: z.string().min(1),
        status: z.enum(SESSION_INDEX_TOOL_STATUSES),
        startedAt: TimestampSchema.optional(),
        completedAt: TimestampSchema.optional(),
        failedAt: TimestampSchema.optional(),
        lastMessage: z.string().min(1).optional(),
        result: ToolResultSchema.optional(),
        appliedFiles: z.array(z.string().min(1)).optional(),
    })
    .strict();

export const SessionIndexProviderFailureRecordSchema = z
    .object({
        kind: z.literal('provider_failure'),
        sessionId: SessionIdSchema,
        eventId: EventIdSchema,
        timestamp: TimestampSchema,
        requestId: z.string().min(1),
        providerTurnId: z.string().min(1).optional(),
        error: ProtocolErrorSchema,
    })
    .strict();

export const SessionIndexRecordSchema = z.discriminatedUnion('kind', [
    SessionIndexSessionRecordSchema,
    SessionIndexRunRecordSchema,
    SessionIndexApprovalRecordSchema,
    SessionIndexToolRecordSchema,
    SessionIndexProviderFailureRecordSchema,
]);

export const SessionIndexDiagnosticSchema = z
    .object({
        kind: z.literal('corrupt_jsonl'),
        sessionId: SessionIdSchema,
        filePath: SourceFilePathSchema,
        code: z.enum(SESSION_INDEX_DIAGNOSTIC_CODES),
        message: z.string().min(1),
        lineNumber: z.number().int().positive().optional(),
    })
    .strict();

export const SessionIndexFileSchema = z
    .object({
        version: z.literal(SESSION_INDEX_FILE_VERSION),
        records: z.array(SessionIndexRecordSchema),
        diagnostics: z.array(SessionIndexDiagnosticSchema),
    })
    .strict();

export type SessionIndexFile = {
    readonly version: typeof SESSION_INDEX_FILE_VERSION;
    readonly records: readonly SessionIndexRecord[];
    readonly diagnostics: readonly SessionIndexDiagnostic[];
};
