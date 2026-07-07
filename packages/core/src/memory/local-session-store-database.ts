import { openLocalLibsqlDb, runLocalLibsqlWrite } from '../db/local-libsql-db.js';
import { resolveMissionControlDataDir } from './data-dir.js';
import { localSessionDbUrl } from './local-session-store-paths.js';
import { importLegacySessionCompatibilityWindow } from './session-import.js';
import { openSqliteSessionProjectionStore, type SqliteSessionProjectionStore } from './sqlite-session-projection.js';
import { mkdir } from 'node:fs/promises';

export async function openLocalSessionProjectionStore(
    input: { readonly dataDir?: string; readonly now?: () => string } = {},
): Promise<SqliteSessionProjectionStore> {
    const dataDir = input.dataDir ?? resolveMissionControlDataDir();
    await ensureLocalSessionDatabase({
        dataDir,
        ...(input.now !== undefined ? { now: input.now } : {}),
    });
    return openSqliteSessionProjectionStore({ url: localSessionDbUrl(dataDir) });
}

export async function deleteLocalSessionRows(input: {
    readonly dataDir?: string;
    readonly sessionIds: readonly string[];
    readonly now?: () => string;
}): Promise<void> {
    const dataDir = input.dataDir ?? resolveMissionControlDataDir();
    await ensureLocalSessionDatabase({
        dataDir,
        ...(input.now !== undefined ? { now: input.now } : {}),
    });
    const runtime = await openLocalLibsqlDb({ url: localSessionDbUrl(dataDir) });
    try {
        for (const sessionId of input.sessionIds) {
            await runLocalLibsqlWrite(runtime, (client) =>
                client.batch(
                    [
                        { sql: 'DELETE FROM session_parts WHERE session_id = ?', args: [sessionId] },
                        { sql: 'DELETE FROM session_messages WHERE session_id = ?', args: [sessionId] },
                        { sql: 'DELETE FROM session_events WHERE session_id = ?', args: [sessionId] },
                        { sql: 'DELETE FROM session_event_sequences WHERE session_id = ?', args: [sessionId] },
                        { sql: 'DELETE FROM session_projection_runs WHERE session_id = ?', args: [sessionId] },
                        { sql: 'DELETE FROM session_projection_diagnostics WHERE session_id = ?', args: [sessionId] },
                        { sql: 'DELETE FROM approvals WHERE session_id = ?', args: [sessionId] },
                        { sql: 'DELETE FROM tool_calls WHERE session_id = ?', args: [sessionId] },
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
                        {
                            sql: 'UPDATE async_jobs SET parent_session_id = NULL WHERE parent_session_id = ?',
                            args: [sessionId],
                        },
                        {
                            sql: 'UPDATE async_jobs SET child_session_id = NULL WHERE child_session_id = ?',
                            args: [sessionId],
                        },
                        { sql: 'DELETE FROM sessions WHERE session_id = ?', args: [sessionId] },
                    ],
                    'write',
                ),
            );
        }
    } finally {
        runtime.close();
    }
}

export async function ensureLocalSessionDatabase(input: {
    readonly dataDir: string;
    readonly now?: () => string;
}): Promise<void> {
    await mkdir(input.dataDir, { recursive: true });
    const runtime = await openLocalLibsqlDb({ url: localSessionDbUrl(input.dataDir) });
    try {
        await importLegacySessionCompatibilityWindow({
            ...runtime,
            dataDir: input.dataDir,
            ...(input.now !== undefined ? { now: input.now } : {}),
        });
    } finally {
        runtime.close();
    }
    const projectionStore = await openSqliteSessionProjectionStore({ url: localSessionDbUrl(input.dataDir) });
    projectionStore.close();
}
