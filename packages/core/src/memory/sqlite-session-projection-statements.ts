import type { InStatement } from '@libsql/client';
import type { AgentEventEnvelope } from '@mission-control/protocol';
import type {
    SessionProjectionApprovalRecord,
    SessionProjectionDiagnostic,
    SessionProjectionProviderFailureRecord,
    SessionProjectionRecord,
    SessionProjectionRunRecord,
    SessionProjectionSessionRecord,
    SessionProjectionToolRecord,
} from './session-projection-types.js';
import {
    messageProjectionStatements,
    toolArgumentsById,
    toolNamesById,
} from './sqlite-session-projection-message-statements.js';
import {
    insertApprovalStatement,
    insertDiagnosticStatement,
    insertProviderFailureStatement,
    insertRunStatement,
    insertToolStatement,
} from './sqlite-session-projection-record-statements.js';
import { insertAwaitingStatement, insertSessionStatement } from './sqlite-session-projection-session-statements.js';

export function replaceStatements(input: {
    readonly sessionId: string;
    readonly records: readonly SessionProjectionRecord[];
    readonly diagnostics: readonly SessionProjectionDiagnostic[];
    readonly envelopes: readonly AgentEventEnvelope[];
}): readonly InStatement[] {
    const records = splitRecords(input.records);
    return [
        ...deleteStatements(input.sessionId),
        ...records.sessions.map(insertSessionStatement),
        ...records.sessions.flatMap((record) => {
            const statement = insertAwaitingStatement(record);
            return statement === undefined ? [] : [statement];
        }),
        ...records.runs.map(insertRunStatement),
        ...records.approvals.map(insertApprovalStatement),
        ...records.tools.map(insertToolStatement(toolNamesById(input.envelopes), toolArgumentsById(input.envelopes))),
        ...records.providerFailures.map(insertProviderFailureStatement),
        ...messageProjectionStatements(input.envelopes),
        ...input.diagnostics.map(insertDiagnosticStatement),
        refreshAwaitingStatement(input.sessionId),
    ];
}

function deleteStatements(sessionId: string): readonly InStatement[] {
    const tables = [
        'session_parts',
        'session_messages',
        'approvals',
        'tool_calls',
        'provider_failures',
        'session_projection_runs',
        'session_projection_diagnostics',
    ];
    return [
        {
            sql:
                'DELETE FROM session_awaits WHERE session_id = ? AND status = ? ' +
                "AND (source_kind IN (?, ?, ?) OR json_extract(metadata_json, '$.owner') = ?)",
            args: [sessionId, 'pending', 'approval', 'run', 'tool_call', 'projection'],
        },
        ...tables.map((table) => ({ sql: `DELETE FROM ${table} WHERE session_id = ?`, args: [sessionId] })),
    ];
}

function refreshAwaitingStatement(sessionId: string): InStatement {
    return {
        sql: `
            WITH primary_wait AS (
                SELECT wait_id, reason, created_at
                FROM session_awaits
                WHERE session_id = ? AND status = ?
                ORDER BY CASE reason WHEN ? THEN 0 WHEN ? THEN 1 WHEN ? THEN 2 ELSE 3 END, created_at, wait_id
                LIMIT 1
            )
            UPDATE sessions
            SET status = ?,
                awaiting_reason = (SELECT reason FROM primary_wait),
                primary_wait_id = (SELECT wait_id FROM primary_wait),
                updated_at = COALESCE((SELECT created_at FROM primary_wait), updated_at),
                last_activity_at = COALESCE((SELECT created_at FROM primary_wait), last_activity_at)
            WHERE session_id = ?
              AND status NOT IN (?, ?)
              AND EXISTS (SELECT 1 FROM primary_wait)
        `,
        args: [sessionId, 'pending', 'approval', 'user_input', 'subagent', 'awaiting', sessionId, 'stopped', 'failed'],
    };
}

type SplitRecords = {
    readonly sessions: readonly SessionProjectionSessionRecord[];
    readonly runs: readonly SessionProjectionRunRecord[];
    readonly approvals: readonly SessionProjectionApprovalRecord[];
    readonly tools: readonly SessionProjectionToolRecord[];
    readonly providerFailures: readonly SessionProjectionProviderFailureRecord[];
};

function splitRecords(records: readonly SessionProjectionRecord[]): SplitRecords {
    const sessions: SessionProjectionSessionRecord[] = [];
    const runs: SessionProjectionRunRecord[] = [];
    const approvals: SessionProjectionApprovalRecord[] = [];
    const tools: SessionProjectionToolRecord[] = [];
    const providerFailures: SessionProjectionProviderFailureRecord[] = [];
    for (const record of records) {
        switch (record.kind) {
            case 'session':
                sessions.push(record);
                break;
            case 'run':
                runs.push(record);
                break;
            case 'approval':
                approvals.push(record);
                break;
            case 'tool':
                tools.push(record);
                break;
            case 'provider_failure':
                providerFailures.push(record);
                break;
            default:
                assertNever(record);
        }
    }
    return { sessions, runs, approvals, tools, providerFailures };
}

function assertNever(value: never): never {
    throw new Error(`Unhandled sqlite projection record variant: ${JSON.stringify(value)}`);
}
