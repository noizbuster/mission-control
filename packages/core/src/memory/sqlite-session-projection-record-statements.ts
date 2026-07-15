import type { InStatement } from '@libsql/client';
import type { ToolOutcomeStatus } from '../session-replay-types';
import type {
    SessionProjectionApprovalRecord,
    SessionProjectionDiagnostic,
    SessionProjectionProviderFailureRecord,
    SessionProjectionRunRecord,
    SessionProjectionToolRecord,
} from './session-projection-types';

export function insertRunStatement(record: SessionProjectionRunRecord): InStatement {
    return {
        sql: `
            INSERT INTO session_projection_runs (
                session_id, event_id, sequence, timestamp, event_type, command, state, run_id,
                input_id, provider_turn_id, reason, error_code
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
            record.sessionId,
            record.eventId,
            record.sequence,
            record.timestamp,
            record.eventType,
            record.command ?? null,
            record.state ?? null,
            record.runId ?? null,
            record.inputId ?? null,
            record.providerTurnId ?? null,
            record.reason ?? null,
            record.errorCode ?? null,
        ],
    };
}

export function insertApprovalStatement(record: SessionProjectionApprovalRecord): InStatement {
    return {
        sql: `
            INSERT INTO approvals (
                approval_id, session_id, status, subject_kind, subject_id, requested_at, decided_at, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
            record.approvalId,
            record.sessionId,
            record.state,
            record.subject.kind,
            record.subject.id,
            record.requestedAt,
            record.decidedAt ?? null,
            JSON.stringify({ eventId: record.eventId, updatedAt: record.updatedAt }),
        ],
    };
}

export function insertToolStatement(
    namesById: ReadonlyMap<string, string>,
    argumentsById: ReadonlyMap<string, string>,
): (record: SessionProjectionToolRecord) => InStatement {
    return (record) => ({
        sql: `
            INSERT INTO tool_calls (
                tool_call_id, session_id, name, status, arguments_json, result_json,
                started_at, completed_at, failed_at, last_message, error_json, applied_files_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
            record.toolId,
            record.sessionId,
            namesById.get(record.toolId) ?? record.toolId,
            sqliteToolStatus(record.status),
            argumentsById.get(record.toolId) ?? null,
            jsonOrNull(record.result),
            record.startedAt ?? null,
            record.completedAt ?? null,
            record.failedAt ?? null,
            record.lastMessage ?? null,
            jsonOrNull(record.result?.error),
            jsonOrNull(record.appliedFiles),
        ],
    });
}

export function insertProviderFailureStatement(record: SessionProjectionProviderFailureRecord): InStatement {
    return {
        sql: `
            INSERT INTO provider_failures (
                failure_id, session_id, event_id, request_id, provider_turn_id, timestamp, error_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
            record.eventId,
            record.sessionId,
            record.eventId,
            record.requestId,
            record.providerTurnId ?? null,
            record.timestamp,
            JSON.stringify(record.error),
        ],
    };
}

export function insertDiagnosticStatement(record: SessionProjectionDiagnostic): InStatement {
    return {
        sql: `
            INSERT INTO session_projection_diagnostics (session_id, file_path, code, message, line_number)
            VALUES (?, ?, ?, ?, ?)
        `,
        args: [record.sessionId, record.filePath, record.code, record.message, record.lineNumber ?? null],
    };
}

function sqliteToolStatus(status: ToolOutcomeStatus): 'running' | 'completed' | 'failed' {
    switch (status) {
        case 'started':
            return 'running';
        case 'completed':
            return 'completed';
        case 'failed':
            return 'failed';
        default:
            return assertNever(status);
    }
}

function jsonOrNull(value: unknown | undefined): string | null {
    return value === undefined ? null : JSON.stringify(value);
}

function assertNever(value: never): never {
    throw new Error(`Unhandled sqlite projection statement variant: ${JSON.stringify(value)}`);
}
