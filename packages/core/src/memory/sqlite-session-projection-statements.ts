import type { AgentEventEnvelope } from '@mission-control/protocol';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { MissionControlDrizzleDb } from '../db/drizzle-client';
import {
    approvals,
    providerFailures,
    sessionAwaits,
    sessionMessages,
    sessionParts,
    sessionProjectionDiagnostics,
    sessionProjectionRuns,
    toolCalls,
} from '../db/schema';
import type {
    SessionProjectionApprovalRecord,
    SessionProjectionDiagnostic,
    SessionProjectionProviderFailureRecord,
    SessionProjectionRecord,
    SessionProjectionRunRecord,
    SessionProjectionSessionRecord,
    SessionProjectionToolRecord,
} from './session-projection-types';
import { projectInputStatements } from './sqlite-session-projection-input-statements';
import {
    projectMessageStatements,
    toolArgumentsById,
    toolNamesById,
} from './sqlite-session-projection-message-statements';
import {
    insertApprovalRecord,
    insertDiagnosticRecord,
    insertProviderFailureRecord,
    insertRunRecord,
    insertToolRecord,
} from './sqlite-session-projection-record-statements';
import { insertAwaitingRecord, insertSessionRecord } from './sqlite-session-projection-session-statements';
import { projectCancelledWaitStatements } from './sqlite-session-projection-wait-statements';

export async function replaceSessionProjectionRecords(
    db: MissionControlDrizzleDb,
    input: {
        readonly sessionId: string;
        readonly records: readonly SessionProjectionRecord[];
        readonly diagnostics: readonly SessionProjectionDiagnostic[];
        readonly envelopes: readonly AgentEventEnvelope[];
    },
): Promise<void> {
    const records = splitRecords(input.records);
    await deleteProjectionRows(db, input.sessionId);
    for (const record of records.sessions) {
        await insertSessionRecord(db, record);
        await insertAwaitingRecord(db, record);
    }
    await projectInputStatements(db, input.envelopes);
    await projectCancelledWaitStatements(db, input.envelopes);
    for (const record of records.runs) {
        await insertRunRecord(db, record);
    }
    for (const record of records.approvals) {
        await insertApprovalRecord(db, record);
    }
    const insertTool = insertToolRecord(db, toolNamesById(input.envelopes), toolArgumentsById(input.envelopes));
    for (const record of records.tools) {
        await insertTool(record);
    }
    for (const record of records.providerFailures) {
        await insertProviderFailureRecord(db, record);
    }
    await projectMessageStatements(db, input.envelopes);
    for (const diagnostic of input.diagnostics) {
        await insertDiagnosticRecord(db, diagnostic);
    }
    await refreshAwaitingStatus(db, input.sessionId);
}

async function deleteProjectionRows(db: MissionControlDrizzleDb, sessionId: string): Promise<void> {
    await db
        .delete(sessionAwaits)
        .where(
            and(
                eq(sessionAwaits.sessionId, sessionId),
                eq(sessionAwaits.status, 'pending'),
                or(
                    inArray(sessionAwaits.sourceKind, ['approval', 'run', 'tool_call']),
                    sql`json_extract(${sessionAwaits.metadataJson}, '$.owner') = ${'projection'}`,
                ),
            ),
        );
    await db.delete(sessionParts).where(eq(sessionParts.sessionId, sessionId));
    await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, sessionId));
    await db.delete(approvals).where(eq(approvals.sessionId, sessionId));
    await db.delete(toolCalls).where(eq(toolCalls.sessionId, sessionId));
    await db.delete(providerFailures).where(eq(providerFailures.sessionId, sessionId));
    await db.delete(sessionProjectionRuns).where(eq(sessionProjectionRuns.sessionId, sessionId));
    await db.delete(sessionProjectionDiagnostics).where(eq(sessionProjectionDiagnostics.sessionId, sessionId));
}

async function refreshAwaitingStatus(db: MissionControlDrizzleDb, sessionId: string): Promise<void> {
    await db.run(sql`
        WITH primary_wait AS (
            SELECT wait_id, reason, created_at
            FROM session_awaits
            WHERE session_id = ${sessionId} AND status = ${'pending'}
            ORDER BY CASE reason
                WHEN ${'approval'} THEN 0
                WHEN ${'user_input'} THEN 1
                WHEN ${'subagent'} THEN 2
                ELSE 3
            END, created_at, wait_id
            LIMIT 1
        )
        UPDATE sessions
        SET status = ${'awaiting'},
            awaiting_reason = (SELECT reason FROM primary_wait),
            primary_wait_id = (SELECT wait_id FROM primary_wait),
            updated_at = COALESCE((SELECT created_at FROM primary_wait), updated_at),
            last_activity_at = COALESCE((SELECT created_at FROM primary_wait), last_activity_at)
        WHERE session_id = ${sessionId}
          AND status NOT IN (${'stopped'}, ${'failed'})
          AND EXISTS (SELECT 1 FROM primary_wait)
    `);
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
