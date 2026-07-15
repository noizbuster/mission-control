import { type InStatement } from '@libsql/client';
import { z } from 'zod';
import { runLocalLibsqlWrite } from '../db/local-libsql-db.js';
import { runLocalLibsqlClientTransaction } from '../db/local-libsql-transaction.js';
import type { ObservabilityRedactor } from '../providers/observability-redactor.js';
import { openCanonicalRuntimeDb } from '../runtime/local-runtime-db.js';
import { readCanonicalSessionTree } from '../runtime/session-stop-tree-resolver.js';
import type { SessionStoreIdentity } from '../runtime/session-store-identity.js';
import { computeCanonicalSessionTreeToken } from '../runtime/session-tree-token.js';
import { resolveMissionControlDataDir } from './data-dir.js';
import { importLegacySessionCompatibilityWindow } from './session-import.js';
import { createSqliteSessionProjectionStore, type SqliteSessionProjectionStore } from './sqlite-session-projection.js';

export type EnsuredLocalSessionDatabase = {
    readonly identity: SessionStoreIdentity;
    readonly runtime: Awaited<ReturnType<typeof openCanonicalRuntimeDb>>['runtime'];
};

export async function openLocalSessionProjectionStore(
    input: { readonly dataDir?: string; readonly now?: () => string } = {},
): Promise<SqliteSessionProjectionStore> {
    const dataDir = input.dataDir ?? resolveMissionControlDataDir();
    const opened = await openEnsuredLocalSessionDatabase({
        dataDir,
        ...(input.now !== undefined ? { now: input.now } : {}),
    });
    return createSqliteSessionProjectionStore(opened.runtime);
}

export async function deleteLocalSessionRows(input: {
    readonly dataDir?: string;
    readonly sessionIds: readonly string[];
    readonly now?: () => string;
}): Promise<void> {
    const dataDir = input.dataDir ?? resolveMissionControlDataDir();
    const { runtime } = await openEnsuredLocalSessionDatabase({
        dataDir,
        ...(input.now !== undefined ? { now: input.now } : {}),
    });
    try {
        for (const sessionId of input.sessionIds) {
            await runLocalLibsqlWrite(runtime, (client) => client.batch(sessionDeleteStatements(sessionId), 'write'));
        }
    } finally {
        runtime.close();
    }
}

export type LocalSessionTreeDeleteRecord = {
    readonly sessionId: string;
    readonly eventCount: number;
};

export type LocalSessionTreeDeleteErrorCode =
    | 'session_not_found'
    | 'unstable_session_tree'
    | 'session_tree_changed'
    | 'session_live_locked';

export class LocalSessionTreeDeleteError extends Error {
    readonly code: LocalSessionTreeDeleteErrorCode;

    constructor(code: LocalSessionTreeDeleteErrorCode) {
        super(code);
        this.name = 'LocalSessionTreeDeleteError';
        this.code = code;
    }
}

const eventCountRowSchema = z.object({
    session_id: z.string(),
    event_count: z.number().int().nonnegative(),
});

export async function deleteLocalSessionTreeRows(input: {
    readonly dataDir?: string;
    readonly targetSessionId: string;
    readonly expectedTreeToken?: string;
    readonly nowWallMs?: number;
}): Promise<readonly LocalSessionTreeDeleteRecord[]> {
    const dataDir = input.dataDir ?? resolveMissionControlDataDir();
    const { identity, runtime } = await openEnsuredLocalSessionDatabase({ dataDir });
    try {
        return await runLocalLibsqlWrite(runtime, (client) =>
            runLocalLibsqlClientTransaction(client, async () => {
                const tree = await readCanonicalSessionTree(client, input.targetSessionId);
                if (!tree.ok) throw new LocalSessionTreeDeleteError(tree.errorCode);
                const target = tree.nodes.find(({ sessionId }) => sessionId === input.targetSessionId);
                if (target === undefined) throw new LocalSessionTreeDeleteError('session_not_found');
                const nodes = [{ ...target, depth: 0 }, ...tree.descendants];
                const token = computeCanonicalSessionTreeToken(nodes);
                if (input.expectedTreeToken !== undefined && input.expectedTreeToken !== token) {
                    throw new LocalSessionTreeDeleteError('session_tree_changed');
                }

                const sessionIds = nodes.map(({ sessionId }) => sessionId);
                const placeholders = sessionIds.map(() => '?').join(', ');
                const liveLease = await client.execute({
                    sql:
                        `SELECT 1 FROM session_control_leases WHERE db_identity = ? AND session_id IN (${placeholders}) ` +
                        'AND expires_wall_ms > ? LIMIT 1',
                    args: [identity.dbIdentity, ...sessionIds, input.nowWallMs ?? Date.now()],
                });
                if (liveLease.rows[0] !== undefined) throw new LocalSessionTreeDeleteError('session_live_locked');

                const counts = await client.execute({
                    sql:
                        `SELECT session_id, COUNT(*) AS event_count FROM session_events WHERE session_id IN (${placeholders}) ` +
                        'GROUP BY session_id',
                    args: sessionIds,
                });
                const eventCounts = new Map(
                    counts.rows.map((row) => {
                        const parsed = eventCountRowSchema.parse(row);
                        return [parsed.session_id, parsed.event_count] as const;
                    }),
                );
                for (const sessionId of sessionIds) {
                    for (const statement of sessionDeleteStatements(sessionId)) await client.execute(statement);
                }
                return sessionIds.map((sessionId) => ({ sessionId, eventCount: eventCounts.get(sessionId) ?? 0 }));
            }),
        );
    } finally {
        runtime.close();
    }
}

function sessionDeleteStatements(sessionId: string): InStatement[] {
    return [
        { sql: 'DELETE FROM session_parts WHERE session_id = ?', args: [sessionId] },
        { sql: 'DELETE FROM session_messages WHERE session_id = ?', args: [sessionId] },
        { sql: 'DELETE FROM session_events WHERE session_id = ?', args: [sessionId] },
        { sql: 'DELETE FROM session_event_sequences WHERE session_id = ?', args: [sessionId] },
        { sql: 'DELETE FROM session_projection_runs WHERE session_id = ?', args: [sessionId] },
        { sql: 'DELETE FROM session_projection_diagnostics WHERE session_id = ?', args: [sessionId] },
        { sql: 'DELETE FROM approvals WHERE session_id = ?', args: [sessionId] },
        { sql: 'DELETE FROM tool_calls WHERE session_id = ?', args: [sessionId] },
        { sql: 'DELETE FROM desktop_tool_proposals WHERE session_id = ?', args: [sessionId] },
        { sql: 'DELETE FROM desktop_approval_effects WHERE session_id = ?', args: [sessionId] },
        { sql: 'DELETE FROM provider_failures WHERE session_id = ?', args: [sessionId] },
        { sql: 'DELETE FROM session_inputs WHERE session_id = ?', args: [sessionId] },
        {
            sql: 'DELETE FROM session_awaits WHERE session_id = ? OR child_session_id = ?',
            args: [sessionId, sessionId],
        },
        { sql: 'DELETE FROM context_epochs WHERE session_id = ?', args: [sessionId] },
        {
            sql: 'DELETE FROM session_relations WHERE parent_session_id = ? OR child_session_id = ?',
            args: [sessionId, sessionId],
        },
        { sql: 'UPDATE mission_runs SET session_id = NULL WHERE session_id = ?', args: [sessionId] },
        { sql: 'UPDATE runtime_agents SET session_id = NULL WHERE session_id = ?', args: [sessionId] },
        { sql: 'UPDATE async_jobs SET parent_session_id = NULL WHERE parent_session_id = ?', args: [sessionId] },
        { sql: 'UPDATE async_jobs SET child_session_id = NULL WHERE child_session_id = ?', args: [sessionId] },
        { sql: 'DELETE FROM sessions WHERE session_id = ?', args: [sessionId] },
    ];
}

export async function ensureLocalSessionDatabase(input: {
    readonly dataDir: string;
    readonly now?: () => string;
    readonly observabilityRedactor?: ObservabilityRedactor;
}): Promise<SessionStoreIdentity> {
    const { identity, runtime } = await openEnsuredLocalSessionDatabase(input);
    runtime.close();
    return identity;
}

export async function openEnsuredLocalSessionDatabase(input: {
    readonly dataDir: string;
    readonly now?: () => string;
    readonly observabilityRedactor?: ObservabilityRedactor;
}): Promise<EnsuredLocalSessionDatabase> {
    const opened = await openCanonicalRuntimeDb({ dataDir: input.dataDir });
    try {
        await importLegacySessionCompatibilityWindow({
            ...opened.runtime,
            dataDir: opened.identity.canonicalDataDir,
            includeRunSources: false,
            ...(input.now !== undefined ? { now: input.now } : {}),
            ...(input.observabilityRedactor !== undefined
                ? { observabilityRedactor: input.observabilityRedactor }
                : {}),
        });
        return opened;
    } catch (error: unknown) {
        opened.runtime.close();
        throw error;
    }
}
