import type { AgentEventEnvelope } from '@mission-control/protocol';
import { and, asc, eq, sql } from 'drizzle-orm';
import { drizzleFromClient } from '../db/drizzle-client';
import { type LocalLibsqlDb, runLocalLibsqlWrite } from '../db/local-libsql-db';
import { runLocalLibsqlClientTransaction } from '../db/local-libsql-transaction';
import { openMissionControlDb } from '../db/mission-control-db';
import {
    approvals,
    providerFailures,
    sessionAwaits,
    sessionProjectionDiagnostics,
    sessionProjectionRuns,
    sessions,
    toolCalls,
} from '../db/schema';
import { refreshSessionAwaitingFromPendingWaits } from './session-awaiting-sql';
import { deriveSessionProjectionRecordsFromEnvelopes } from './session-projection';
import type {
    SessionProjectionApprovalRecord,
    SessionProjectionDiagnostic,
    SessionProjectionProviderFailureRecord,
    SessionProjectionRebuildResult,
    SessionProjectionRecord,
    SessionProjectionRunRecord,
    SessionProjectionSessionRecord,
    SessionProjectionToolRecord,
} from './session-projection-types';
import { parseSqliteProjectionInput } from './sqlite-session-projection-input';
import {
    approvalRecordFromRow,
    approvalRowSchema,
    diagnosticFromRow,
    diagnosticRowSchema,
    providerFailureRecordFromRow,
    providerFailureRowSchema,
    runRecordFromRow,
    runRowSchema,
    sessionRecordFromRow,
    sessionRowSchema,
    toolRecordFromRow,
    toolRowSchema,
} from './sqlite-session-projection-rows';
import { replaceSessionProjectionRecords } from './sqlite-session-projection-statements';

export type SqliteSessionProjectionStore = {
    replaceSessionProjection(input: {
        readonly sessionId: string;
        readonly records: readonly SessionProjectionRecord[];
        readonly diagnostics: readonly SessionProjectionDiagnostic[];
        readonly envelopes: readonly AgentEventEnvelope[];
    }): Promise<void>;
    listSessions(): Promise<readonly SessionProjectionSessionRecord[]>;
    getSession(sessionId: string): Promise<SessionProjectionSessionRecord | null>;
    getRuns(sessionId: string): Promise<readonly SessionProjectionRunRecord[]>;
    getApprovals(sessionId: string): Promise<readonly SessionProjectionApprovalRecord[]>;
    getTools(sessionId: string): Promise<readonly SessionProjectionToolRecord[]>;
    getProviderFailures(sessionId: string): Promise<readonly SessionProjectionProviderFailureRecord[]>;
    getDiagnostics(sessionId: string): Promise<readonly SessionProjectionDiagnostic[]>;
    close(): void;
};

export async function openSqliteSessionProjectionStore(input: {
    readonly dataDir?: string;
}): Promise<SqliteSessionProjectionStore> {
    const runtime = await openMissionControlDb({
        ...(input.dataDir !== undefined ? { dataDir: input.dataDir } : {}),
    });
    return createSqliteSessionProjectionStore(runtime);
}

export function createSqliteSessionProjectionStore(runtime: LocalLibsqlDb): SqliteSessionProjectionStore {
    return new LibsqlSessionProjectionStore(runtime);
}

export async function projectSessionEventsToSqlite(input: {
    readonly store: SqliteSessionProjectionStore;
    readonly sessionId: string;
    readonly sourcePath: string;
    readonly envelopes: readonly unknown[];
}): Promise<SessionProjectionRebuildResult> {
    const parsed = parseSqliteProjectionInput(input);
    if (parsed.kind === 'diagnostic') {
        await input.store.replaceSessionProjection({
            sessionId: input.sessionId,
            records: [],
            diagnostics: [parsed.diagnostic],
            envelopes: [],
        });
        return { sessionId: input.sessionId, projectedRecords: 0, diagnostics: [parsed.diagnostic] };
    }
    const projection = deriveSessionProjectionRecordsFromEnvelopes({
        sessionId: input.sessionId,
        filePath: input.sourcePath,
        envelopes: parsed.envelopes,
    });
    await input.store.replaceSessionProjection({
        sessionId: input.sessionId,
        records: projection.records,
        diagnostics: projection.diagnostics,
        envelopes: parsed.envelopes,
    });
    return {
        sessionId: input.sessionId,
        projectedRecords: projection.records.length,
        diagnostics: projection.diagnostics,
    };
}

class LibsqlSessionProjectionStore implements SqliteSessionProjectionStore {
    private readonly runtime: LocalLibsqlDb;

    constructor(runtime: LocalLibsqlDb) {
        this.runtime = runtime;
    }

    async replaceSessionProjection(input: {
        readonly sessionId: string;
        readonly records: readonly SessionProjectionRecord[];
        readonly diagnostics: readonly SessionProjectionDiagnostic[];
        readonly envelopes: readonly AgentEventEnvelope[];
    }): Promise<void> {
        await runLocalLibsqlWrite(this.runtime, async (client) => {
            await runLocalLibsqlClientTransaction(client, async () => {
                const db = drizzleFromClient(client);
                await replaceSessionProjectionRecords(db, input);
                await refreshSessionAwaitingFromPendingWaits({
                    client,
                    sessionId: input.sessionId,
                    now: input.envelopes.at(-1)?.event.timestamp ?? new Date(0).toISOString(),
                });
            });
        });
    }

    async listSessions(): Promise<readonly SessionProjectionSessionRecord[]> {
        const db = drizzleFromClient(this.runtime.client);
        const rows = await db
            .select(sessionSelectColumns())
            .from(sessions)
            .leftJoin(
                sessionAwaits,
                and(eq(sessionAwaits.sessionId, sessions.sessionId), eq(sessionAwaits.waitId, sessions.primaryWaitId)),
            )
            .orderBy(asc(sessions.updatedAt), asc(sessions.sessionId));
        return rows.map((row) => sessionRecordFromRow(sessionRowSchema.parse(row)));
    }

    async getSession(sessionId: string): Promise<SessionProjectionSessionRecord | null> {
        const db = drizzleFromClient(this.runtime.client);
        const rows = await db
            .select(sessionSelectColumns())
            .from(sessions)
            .leftJoin(
                sessionAwaits,
                and(eq(sessionAwaits.sessionId, sessions.sessionId), eq(sessionAwaits.waitId, sessions.primaryWaitId)),
            )
            .where(eq(sessions.sessionId, sessionId));
        const row = rows[0];
        return row === undefined ? null : sessionRecordFromRow(sessionRowSchema.parse(row));
    }

    async getRuns(sessionId: string): Promise<readonly SessionProjectionRunRecord[]> {
        const db = drizzleFromClient(this.runtime.client);
        const rows = await db
            .select()
            .from(sessionProjectionRuns)
            .where(eq(sessionProjectionRuns.sessionId, sessionId))
            .orderBy(asc(sessionProjectionRuns.sequence), asc(sessionProjectionRuns.eventId));
        return rows.map((row) => runRecordFromRow(runRowSchema.parse(row)));
    }

    async getApprovals(sessionId: string): Promise<readonly SessionProjectionApprovalRecord[]> {
        const db = drizzleFromClient(this.runtime.client);
        const rows = await db
            .select()
            .from(approvals)
            .where(eq(approvals.sessionId, sessionId))
            .orderBy(asc(approvals.approvalId));
        return rows.map((row) => approvalRecordFromRow(approvalRowSchema.parse(row)));
    }

    async getTools(sessionId: string): Promise<readonly SessionProjectionToolRecord[]> {
        const db = drizzleFromClient(this.runtime.client);
        const rows = await db
            .select()
            .from(toolCalls)
            .where(eq(toolCalls.sessionId, sessionId))
            .orderBy(asc(toolCalls.toolCallId));
        return rows.map((row) =>
            toolRecordFromRow(
                toolRowSchema.parse({
                    toolCallId: row.toolCallId,
                    sessionId: row.sessionId,
                    name: row.name,
                    status: row.status,
                    resultJson: row.resultJson,
                    startedAt: row.startedAt,
                    completedAt: row.completedAt,
                    failedAt: row.failedAt,
                    lastMessage: row.lastMessage,
                    errorJson: row.errorJson,
                    appliedFilesJson: row.appliedFilesJson,
                }),
            ),
        );
    }

    async getProviderFailures(sessionId: string): Promise<readonly SessionProjectionProviderFailureRecord[]> {
        const db = drizzleFromClient(this.runtime.client);
        const rows = await db
            .select()
            .from(providerFailures)
            .where(eq(providerFailures.sessionId, sessionId))
            .orderBy(asc(providerFailures.eventId));
        return rows.map((row) =>
            providerFailureRecordFromRow(
                providerFailureRowSchema.parse({
                    sessionId: row.sessionId,
                    eventId: row.eventId,
                    requestId: row.requestId ?? '',
                    providerTurnId: row.providerTurnId,
                    timestamp: row.timestamp,
                    errorJson: row.errorJson,
                }),
            ),
        );
    }

    async getDiagnostics(sessionId: string): Promise<readonly SessionProjectionDiagnostic[]> {
        const db = drizzleFromClient(this.runtime.client);
        const rows = await db
            .select()
            .from(sessionProjectionDiagnostics)
            .where(eq(sessionProjectionDiagnostics.sessionId, sessionId))
            .orderBy(
                asc(sessionProjectionDiagnostics.filePath),
                asc(sessionProjectionDiagnostics.code),
                sql`COALESCE(${sessionProjectionDiagnostics.lineNumber}, 0)`,
                asc(sessionProjectionDiagnostics.message),
            );
        return rows.map((row) => diagnosticFromRow(diagnosticRowSchema.parse(row)));
    }

    close(): void {
        this.runtime.close();
    }
}

function sessionSelectColumns() {
    return {
        sessionId: sessions.sessionId,
        status: sessions.status,
        createdAt: sessions.createdAt,
        stoppedAt: sessions.stoppedAt,
        lastEventSeq: sessions.lastEventSeq,
        updatedAt: sessions.updatedAt,
        parentSessionId: sessions.parentSessionId,
        title: sessions.title,
        category: sessions.category,
        agentName: sessions.agentName,
        workspacePath: sessions.workspacePath,
        awaitingReason: sessions.awaitingReason,
        primaryWaitId: sessions.primaryWaitId,
        legacyJsonlPath: sessions.legacyJsonlPath,
        metadataJson: sessions.metadataJson,
        waitSourceKind: sessionAwaits.sourceKind,
        waitSourceId: sessionAwaits.sourceId,
        waitRunId: sessionAwaits.runId,
        waitToolCallId: sessionAwaits.toolCallId,
        waitApprovalId: sessionAwaits.approvalId,
        waitJobId: sessionAwaits.jobId,
        waitChildSessionId: sessionAwaits.childSessionId,
    };
}
