import {
    AgentEventTypeSchema,
    ProtocolErrorSchema,
    type SessionAwaitingDetails,
    SessionAwaitingDetailsSchema,
    ToolResultSchema,
} from '@mission-control/protocol';
import { z } from 'zod';
import type { ToolOutcomeStatus } from '../session-replay-types';
import type {
    SessionProjectionApprovalRecord,
    SessionProjectionDiagnostic,
    SessionProjectionProviderFailureRecord,
    SessionProjectionRunRecord,
    SessionProjectionSessionRecord,
    SessionProjectionToolRecord,
} from './session-projection-types';
import {
    approvalRowSchema,
    diagnosticRowSchema,
    providerFailureRowSchema,
    runRowSchema,
    sessionRowSchema,
    toolRowSchema,
} from './sqlite-session-projection-row-schemas';

export function sessionRecordFromRow(row: z.infer<typeof sessionRowSchema>): SessionProjectionSessionRecord {
    const metadata = sessionMetadata(row.metadataJson);
    const awaiting = awaitingDetailsFromRow(row);
    const cwd = row.workspacePath ?? metadata.cwd;
    return {
        kind: 'session',
        sessionId: row.sessionId,
        status: row.status,
        ...(awaiting !== undefined ? { awaiting } : {}),
        startedAt: row.createdAt,
        ...(row.stoppedAt !== null ? { stoppedAt: row.stoppedAt } : {}),
        eventCount: metadata.eventCount,
        ...(row.lastEventSeq !== null ? { lastSequence: row.lastEventSeq } : {}),
        ...(metadata.lastEventId !== undefined ? { lastEventId: metadata.lastEventId } : {}),
        ...(metadata.lastEventType !== undefined ? { lastEventType: metadata.lastEventType } : {}),
        updatedAt: row.updatedAt,
        sourcePath: row.legacyJsonlPath ?? '',
        ...(row.parentSessionId !== null ? { parentSessionId: row.parentSessionId } : {}),
        ...(row.title !== null && row.title !== undefined ? { title: row.title } : {}),
        ...(row.category !== null && row.category !== undefined ? { category: row.category } : {}),
        ...(row.agentName !== null && row.agentName !== undefined ? { agentName: row.agentName } : {}),
        ...(cwd !== undefined && cwd !== null ? { cwd } : {}),
        ...(metadata.trustedRoot !== undefined ? { trustedRoot: metadata.trustedRoot } : {}),
        ...(metadata.workspaceTrust !== undefined ? { workspaceTrust: metadata.workspaceTrust } : {}),
        ...(metadata.name !== undefined ? { name: metadata.name } : {}),
        ...(metadata.messageCount !== undefined ? { messageCount: metadata.messageCount } : {}),
        ...(metadata.activeLeafId !== undefined ? { activeLeafId: metadata.activeLeafId } : {}),
    };
}

export function runRecordFromRow(row: z.infer<typeof runRowSchema>): SessionProjectionRunRecord {
    return {
        kind: 'run',
        sessionId: row.sessionId,
        eventId: row.eventId,
        sequence: row.sequence,
        timestamp: row.timestamp,
        eventType: row.eventType,
        ...(row.command !== null ? { command: row.command } : {}),
        ...(row.state !== null ? { state: row.state } : {}),
        ...(row.runId !== null ? { runId: row.runId } : {}),
        ...(row.inputId !== null ? { inputId: row.inputId } : {}),
        ...(row.providerTurnId !== null ? { providerTurnId: row.providerTurnId } : {}),
        ...(row.reason !== null ? { reason: row.reason } : {}),
        ...(row.errorCode !== null ? { errorCode: row.errorCode } : {}),
    };
}

export function approvalRecordFromRow(row: z.infer<typeof approvalRowSchema>): SessionProjectionApprovalRecord {
    const metadata = metadataForApproval(row.metadataJson);
    return {
        kind: 'approval',
        sessionId: row.sessionId,
        approvalId: row.approvalId,
        eventId: metadata.eventId,
        state: row.status,
        subject: { kind: row.subjectKind, id: row.subjectId },
        requestedAt: row.requestedAt,
        ...(row.decidedAt !== null ? { decidedAt: row.decidedAt } : {}),
        updatedAt: metadata.updatedAt,
    };
}

export function toolRecordFromRow(row: z.infer<typeof toolRowSchema>): SessionProjectionToolRecord {
    const result = row.resultJson !== null ? parseJson(row.resultJson, ToolResultSchema) : undefined;
    const appliedFiles =
        row.appliedFilesJson !== null ? parseJson(row.appliedFilesJson, z.array(z.string())) : undefined;
    return {
        kind: 'tool',
        sessionId: row.sessionId,
        toolId: row.toolCallId,
        status: toolStatusFromSqlite(row.status),
        ...(row.startedAt !== null ? { startedAt: row.startedAt } : {}),
        ...(row.completedAt !== null ? { completedAt: row.completedAt } : {}),
        ...(row.failedAt !== null ? { failedAt: row.failedAt } : {}),
        ...(row.lastMessage !== null ? { lastMessage: row.lastMessage } : {}),
        ...(result !== undefined ? { result } : {}),
        ...(appliedFiles !== undefined ? { appliedFiles } : {}),
    };
}

export function providerFailureRecordFromRow(
    row: z.infer<typeof providerFailureRowSchema>,
): SessionProjectionProviderFailureRecord {
    return {
        kind: 'provider_failure',
        sessionId: row.sessionId,
        eventId: row.eventId,
        timestamp: row.timestamp,
        requestId: row.requestId,
        ...(row.providerTurnId !== null ? { providerTurnId: row.providerTurnId } : {}),
        error: parseJson(row.errorJson, ProtocolErrorSchema),
    };
}

export function diagnosticFromRow(row: z.infer<typeof diagnosticRowSchema>): SessionProjectionDiagnostic {
    return {
        kind: 'corrupt_jsonl',
        sessionId: row.sessionId,
        filePath: row.filePath,
        code: row.code,
        message: row.message,
        ...(row.lineNumber !== null ? { lineNumber: row.lineNumber } : {}),
    };
}

function awaitingDetailsFromRow(row: z.infer<typeof sessionRowSchema>): SessionAwaitingDetails | undefined {
    if (row.status !== 'awaiting' || row.awaitingReason === null) {
        return undefined;
    }
    switch (row.awaitingReason) {
        case 'approval': {
            const approvalId = row.waitApprovalId ?? row.primaryWaitId ?? row.waitSourceId;
            return approvalId === null
                ? undefined
                : parseAwaitingDetails({
                      reason: row.awaitingReason,
                      source: {
                          approvalId,
                          ...(row.waitRunId !== null ? { runId: row.waitRunId } : {}),
                          ...(row.waitToolCallId !== null ? { toolCallId: row.waitToolCallId } : {}),
                      },
                  });
        }
        case 'user_input':
            return parseAwaitingDetails({
                reason: row.awaitingReason,
                source: {
                    ...(row.waitSourceKind === 'operator' && row.waitSourceId !== null
                        ? { inputId: row.waitSourceId }
                        : {}),
                    ...(row.waitRunId !== null ? { runId: row.waitRunId } : {}),
                    ...(row.waitToolCallId !== null ? { toolCallId: row.waitToolCallId } : {}),
                },
            });
        case 'subagent': {
            const jobId = row.waitJobId ?? row.primaryWaitId ?? row.waitSourceId;
            return jobId === null
                ? undefined
                : parseAwaitingDetails({
                      reason: row.awaitingReason,
                      source: {
                          jobId,
                          ...(row.waitChildSessionId !== null ? { childSessionId: row.waitChildSessionId } : {}),
                          ...(row.waitRunId !== null ? { runId: row.waitRunId } : {}),
                          ...(row.waitToolCallId !== null ? { toolCallId: row.waitToolCallId } : {}),
                      },
                  });
        }
        default:
            return assertNever(row.awaitingReason);
    }
}

function metadataForApproval(value: string | null): { readonly eventId: string; readonly updatedAt: string } {
    const parsed = parseJson(value ?? '{}', z.object({ eventId: z.string(), updatedAt: z.string() }).partial());
    return {
        eventId: parsed.eventId ?? 'unknown',
        updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
    };
}

function sessionMetadata(value: string | null): {
    readonly eventCount: number;
    readonly lastEventId?: string | undefined;
    readonly lastEventType?: z.infer<typeof AgentEventTypeSchema> | undefined;
    readonly cwd?: string | undefined;
    readonly trustedRoot?: string | undefined;
    readonly workspaceTrust?: 'trusted' | 'denied' | 'unknown' | undefined;
    readonly name?: string | undefined;
    readonly messageCount?: number | undefined;
    readonly activeLeafId?: string | undefined;
} {
    const parsed = parseJson(
        value ?? '{}',
        z.object({
            eventCount: z.number().default(0),
            lastEventId: z.string().nullable().optional(),
            lastEventType: AgentEventTypeSchema.nullable().optional(),
            cwd: z.string().nullable().optional(),
            trustedRoot: z.string().nullable().optional(),
            workspaceTrust: z.enum(['trusted', 'denied', 'unknown']).nullable().optional(),
            name: z.string().nullable().optional(),
            messageCount: z.number().nullable().optional(),
            activeLeafId: z.string().nullable().optional(),
        }),
    );
    return {
        eventCount: parsed.eventCount,
        ...(parsed.lastEventId !== undefined && parsed.lastEventId !== null ? { lastEventId: parsed.lastEventId } : {}),
        ...(parsed.lastEventType !== undefined && parsed.lastEventType !== null
            ? { lastEventType: parsed.lastEventType }
            : {}),
        ...(parsed.cwd !== undefined && parsed.cwd !== null ? { cwd: parsed.cwd } : {}),
        ...(parsed.trustedRoot !== undefined && parsed.trustedRoot !== null
            ? { trustedRoot: parsed.trustedRoot }
            : {}),
        ...(parsed.workspaceTrust !== undefined && parsed.workspaceTrust !== null
            ? { workspaceTrust: parsed.workspaceTrust }
            : {}),
        ...(parsed.name !== undefined && parsed.name !== null ? { name: parsed.name } : {}),
        ...(parsed.messageCount !== undefined && parsed.messageCount !== null
            ? { messageCount: parsed.messageCount }
            : {}),
        ...(parsed.activeLeafId !== undefined && parsed.activeLeafId !== null
            ? { activeLeafId: parsed.activeLeafId }
            : {}),
    };
}

function parseAwaitingDetails(value: unknown): SessionAwaitingDetails | undefined {
    const parsed = SessionAwaitingDetailsSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

function toolStatusFromSqlite(status: 'running' | 'completed' | 'failed'): ToolOutcomeStatus {
    switch (status) {
        case 'running':
            return 'started';
        case 'completed':
            return 'completed';
        case 'failed':
            return 'failed';
        default:
            return assertNever(status);
    }
}

function parseJson<T>(value: string, schema: z.ZodType<T>): T {
    return schema.parse(JSON.parse(value));
}

function assertNever(value: never): never {
    throw new Error(`Unhandled sqlite projection row variant: ${JSON.stringify(value)}`);
}
