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
    const metadata = sessionMetadata(row.metadata_json);
    const awaiting = awaitingDetailsFromRow(row);
    return {
        kind: 'session',
        sessionId: row.session_id,
        status: row.status,
        ...(awaiting !== undefined ? { awaiting } : {}),
        startedAt: row.created_at,
        ...(row.stopped_at !== null ? { stoppedAt: row.stopped_at } : {}),
        eventCount: metadata.eventCount,
        ...(row.last_event_seq !== null ? { lastSequence: row.last_event_seq } : {}),
        ...(metadata.lastEventId !== undefined ? { lastEventId: metadata.lastEventId } : {}),
        ...(metadata.lastEventType !== undefined ? { lastEventType: metadata.lastEventType } : {}),
        updatedAt: row.updated_at,
        sourcePath: row.legacy_jsonl_path ?? '',
        ...(row.parent_session_id !== null ? { parentSessionId: row.parent_session_id } : {}),
        ...(row.title !== null && row.title !== undefined ? { title: row.title } : {}),
        ...(row.category !== null && row.category !== undefined ? { category: row.category } : {}),
        ...(row.agent_name !== null && row.agent_name !== undefined ? { agentName: row.agent_name } : {}),
    };
}

export function runRecordFromRow(row: z.infer<typeof runRowSchema>): SessionProjectionRunRecord {
    return {
        kind: 'run',
        sessionId: row.session_id,
        eventId: row.event_id,
        sequence: row.sequence,
        timestamp: row.timestamp,
        eventType: row.event_type,
        ...(row.command !== null ? { command: row.command } : {}),
        ...(row.state !== null ? { state: row.state } : {}),
        ...(row.run_id !== null ? { runId: row.run_id } : {}),
        ...(row.input_id !== null ? { inputId: row.input_id } : {}),
        ...(row.provider_turn_id !== null ? { providerTurnId: row.provider_turn_id } : {}),
        ...(row.reason !== null ? { reason: row.reason } : {}),
        ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
    };
}

export function approvalRecordFromRow(row: z.infer<typeof approvalRowSchema>): SessionProjectionApprovalRecord {
    const metadata = metadataForApproval(row.metadata_json);
    return {
        kind: 'approval',
        sessionId: row.session_id,
        approvalId: row.approval_id,
        eventId: metadata.eventId,
        state: row.status,
        subject: { kind: row.subject_kind, id: row.subject_id },
        requestedAt: row.requested_at,
        ...(row.decided_at !== null ? { decidedAt: row.decided_at } : {}),
        updatedAt: metadata.updatedAt,
    };
}

export function toolRecordFromRow(row: z.infer<typeof toolRowSchema>): SessionProjectionToolRecord {
    const result = row.result_json !== null ? parseJson(row.result_json, ToolResultSchema) : undefined;
    const appliedFiles =
        row.applied_files_json !== null ? parseJson(row.applied_files_json, z.array(z.string())) : undefined;
    return {
        kind: 'tool',
        sessionId: row.session_id,
        toolId: row.tool_call_id,
        status: toolStatusFromSqlite(row.status),
        ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
        ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
        ...(row.failed_at !== null ? { failedAt: row.failed_at } : {}),
        ...(row.last_message !== null ? { lastMessage: row.last_message } : {}),
        ...(result !== undefined ? { result } : {}),
        ...(appliedFiles !== undefined ? { appliedFiles } : {}),
    };
}

export function providerFailureRecordFromRow(
    row: z.infer<typeof providerFailureRowSchema>,
): SessionProjectionProviderFailureRecord {
    return {
        kind: 'provider_failure',
        sessionId: row.session_id,
        eventId: row.event_id,
        timestamp: row.timestamp,
        requestId: row.request_id,
        ...(row.provider_turn_id !== null ? { providerTurnId: row.provider_turn_id } : {}),
        error: parseJson(row.error_json, ProtocolErrorSchema),
    };
}

export function diagnosticFromRow(row: z.infer<typeof diagnosticRowSchema>): SessionProjectionDiagnostic {
    return {
        kind: 'corrupt_jsonl',
        sessionId: row.session_id,
        filePath: row.file_path,
        code: row.code,
        message: row.message,
        ...(row.line_number !== null ? { lineNumber: row.line_number } : {}),
    };
}

function awaitingDetailsFromRow(row: z.infer<typeof sessionRowSchema>): SessionAwaitingDetails | undefined {
    if (row.status !== 'awaiting' || row.awaiting_reason === null) {
        return undefined;
    }
    switch (row.awaiting_reason) {
        case 'approval': {
            const approvalId = row.wait_approval_id ?? row.primary_wait_id ?? row.wait_source_id;
            return approvalId === null
                ? undefined
                : parseAwaitingDetails({
                      reason: row.awaiting_reason,
                      source: {
                          approvalId,
                          ...(row.wait_run_id !== null ? { runId: row.wait_run_id } : {}),
                          ...(row.wait_tool_call_id !== null ? { toolCallId: row.wait_tool_call_id } : {}),
                      },
                  });
        }
        case 'user_input':
            return parseAwaitingDetails({
                reason: row.awaiting_reason,
                source: {
                    ...(row.wait_source_kind === 'operator' && row.wait_source_id !== null
                        ? { inputId: row.wait_source_id }
                        : {}),
                    ...(row.wait_run_id !== null ? { runId: row.wait_run_id } : {}),
                    ...(row.wait_tool_call_id !== null ? { toolCallId: row.wait_tool_call_id } : {}),
                },
            });
        case 'subagent': {
            const jobId = row.wait_job_id ?? row.primary_wait_id ?? row.wait_source_id;
            return jobId === null
                ? undefined
                : parseAwaitingDetails({
                      reason: row.awaiting_reason,
                      source: {
                          jobId,
                          ...(row.wait_child_session_id !== null ? { childSessionId: row.wait_child_session_id } : {}),
                          ...(row.wait_run_id !== null ? { runId: row.wait_run_id } : {}),
                          ...(row.wait_tool_call_id !== null ? { toolCallId: row.wait_tool_call_id } : {}),
                      },
                  });
        }
        default:
            return assertNever(row.awaiting_reason);
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
} {
    const parsed = parseJson(
        value ?? '{}',
        z.object({
            eventCount: z.number().default(0),
            lastEventId: z.string().nullable().optional(),
            lastEventType: AgentEventTypeSchema.nullable().optional(),
        }),
    );
    return {
        eventCount: parsed.eventCount,
        ...(parsed.lastEventId !== undefined && parsed.lastEventId !== null ? { lastEventId: parsed.lastEventId } : {}),
        ...(parsed.lastEventType !== undefined && parsed.lastEventType !== null
            ? { lastEventType: parsed.lastEventType }
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
