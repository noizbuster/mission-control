import { sql } from 'drizzle-orm';
import type { MissionControlDrizzleDb } from '../db/drizzle-client';
import {
    approvals,
    providerFailures,
    sessionProjectionDiagnostics,
    sessionProjectionRuns,
    toolCalls,
} from '../db/schema';
import type { ToolOutcomeStatus } from '../session-replay-types';
import type {
    SessionProjectionApprovalRecord,
    SessionProjectionDiagnostic,
    SessionProjectionProviderFailureRecord,
    SessionProjectionRunRecord,
    SessionProjectionToolRecord,
} from './session-projection-types';

export async function insertRunRecord(
    db: MissionControlDrizzleDb,
    record: SessionProjectionRunRecord,
): Promise<void> {
    await db.insert(sessionProjectionRuns).values({
        sessionId: record.sessionId,
        eventId: record.eventId,
        sequence: record.sequence,
        timestamp: record.timestamp,
        eventType: record.eventType,
        command: record.command ?? null,
        state: record.state ?? null,
        runId: record.runId ?? null,
        inputId: record.inputId ?? null,
        providerTurnId: record.providerTurnId ?? null,
        reason: record.reason ?? null,
        errorCode: record.errorCode ?? null,
    });
}

export async function insertApprovalRecord(
    db: MissionControlDrizzleDb,
    record: SessionProjectionApprovalRecord,
): Promise<void> {
    await db.insert(approvals).values({
        approvalId: record.approvalId,
        sessionId: record.sessionId,
        status: record.state,
        subjectKind: record.subject.kind,
        subjectId: record.subject.id,
        requestedAt: record.requestedAt,
        decidedAt: record.decidedAt ?? null,
        metadataJson: JSON.stringify({ eventId: record.eventId, updatedAt: record.updatedAt }),
    });
}

export function insertToolRecord(
    db: MissionControlDrizzleDb,
    namesById: ReadonlyMap<string, string>,
    argumentsById: ReadonlyMap<string, string>,
): (record: SessionProjectionToolRecord) => Promise<void> {
    return async (record) => {
        await db
            .insert(toolCalls)
            .values({
                toolCallId: record.toolId,
                sessionId: record.sessionId,
                name: namesById.get(record.toolId) ?? record.toolId,
                status: sqliteToolStatus(record.status),
                argumentsJson: argumentsById.get(record.toolId) ?? null,
                resultJson: jsonOrNull(record.result),
                startedAt: record.startedAt ?? null,
                completedAt: record.completedAt ?? null,
                failedAt: record.failedAt ?? null,
                lastMessage: record.lastMessage ?? null,
                errorJson: jsonOrNull(record.result?.error),
                appliedFilesJson: jsonOrNull(record.appliedFiles),
            })
            .onConflictDoUpdate({
                target: [toolCalls.sessionId, toolCalls.toolCallId],
                set: {
                    name: sql`excluded.name`,
                    status: sql`excluded.status`,
                    argumentsJson: sql`excluded.arguments_json`,
                    resultJson: sql`excluded.result_json`,
                    startedAt: sql`excluded.started_at`,
                    completedAt: sql`excluded.completed_at`,
                    failedAt: sql`excluded.failed_at`,
                    lastMessage: sql`excluded.last_message`,
                    errorJson: sql`excluded.error_json`,
                    appliedFilesJson: sql`excluded.applied_files_json`,
                },
            });
    };
}

export async function insertProviderFailureRecord(
    db: MissionControlDrizzleDb,
    record: SessionProjectionProviderFailureRecord,
): Promise<void> {
    await db.insert(providerFailures).values({
        failureId: record.eventId,
        sessionId: record.sessionId,
        eventId: record.eventId,
        requestId: record.requestId,
        providerTurnId: record.providerTurnId ?? null,
        timestamp: record.timestamp,
        errorJson: JSON.stringify(record.error),
    });
}

export async function insertDiagnosticRecord(
    db: MissionControlDrizzleDb,
    record: SessionProjectionDiagnostic,
): Promise<void> {
    await db.insert(sessionProjectionDiagnostics).values({
        sessionId: record.sessionId,
        filePath: record.filePath,
        code: record.code,
        message: record.message,
        lineNumber: record.lineNumber ?? null,
    });
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
