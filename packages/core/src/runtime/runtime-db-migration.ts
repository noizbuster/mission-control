import type { Client } from '@libsql/client';
import { type LocalLibsqlDb, runWithLocalLibsqlWriteLock } from '../db/local-libsql-db.js';
import { readExportEnvelopes } from '../memory/session-import-event-sql.js';
import { openSqliteSessionProjectionStore, projectSessionEventsToSqlite } from '../memory/sqlite-session-projection.js';
import {
    copyLegacyRuntimeRows,
    emptyLegacyRuntimeTables,
    loadLegacyRuntimeTables,
    projectionSessionIdsForTables,
} from './runtime-db-migration-copy.js';
import { RuntimeDbMigrationError } from './runtime-db-migration-error.js';
import {
    createExpectedMigrationLedger,
    insertMigrationLedgerRow,
    migrationLedgerMatches,
    readMigrationLedgerRow,
} from './runtime-db-migration-ledger.js';
import { discoverLegacyRuntimeSource, type LegacyRuntimeSource } from './runtime-db-migration-sources.js';
import type { SessionStoreIdentity } from './session-store-identity.js';

const LEGACY_DATABASE_ALIAS = 'legacy_runtime_store';

type MigrationOutcome = {
    readonly sourceManifestSha256: string;
    readonly changed: boolean;
    readonly sessionIds: readonly string[];
};

export type RuntimeDbMigrationEntry = {
    readonly migrationId: string;
    readonly sourceRootFileUrl: string;
    readonly sourceManifestSha256: string;
    readonly changed: boolean;
};

export type RuntimeDbMigrationResult = {
    readonly entries: readonly RuntimeDbMigrationEntry[];
};

export async function migrateLegacyRuntimeStores(input: {
    readonly runtime: LocalLibsqlDb;
    readonly identity: SessionStoreIdentity;
    readonly legacyRoots: readonly string[];
    readonly now?: () => string;
}): Promise<RuntimeDbMigrationResult> {
    const entries: RuntimeDbMigrationEntry[] = [];
    const seenRoots = new Set<string>();
    for (const root of input.legacyRoots) {
        const source = await discoverLegacyRuntimeSource(root, input.identity);
        if (seenRoots.has(source.rootFileUrl)) continue;
        seenRoots.add(source.rootFileUrl);
        const migrated = await migrateSource({
            runtime: input.runtime,
            identity: input.identity,
            source,
            now: input.now ?? (() => new Date().toISOString()),
        });
        await rebuildSessionProjections({
            runtime: input.runtime,
            identity: input.identity,
            sessionIds: migrated.sessionIds,
            migrationId: source.migrationId,
        });
        entries.push({
            migrationId: source.migrationId,
            sourceRootFileUrl: source.rootFileUrl,
            sourceManifestSha256: migrated.sourceManifestSha256,
            changed: migrated.changed,
        });
    }
    return { entries };
}

async function migrateSource(input: {
    readonly runtime: LocalLibsqlDb;
    readonly identity: SessionStoreIdentity;
    readonly source: LegacyRuntimeSource;
    readonly now: () => string;
}): Promise<MigrationOutcome> {
    return runWithLocalLibsqlWriteLock(input.runtime.url, async () => {
        let attached = false;
        let outcome: MigrationOutcome | RuntimeDbMigrationError;
        await input.runtime.client.execute('BEGIN IMMEDIATE TRANSACTION');
        try {
            if (input.source.database !== undefined) {
                await input.runtime.client.execute(
                    `ATTACH DATABASE '${escapeSqlString(`${input.source.database.fileUrl}?mode=ro`)}' AS ${LEGACY_DATABASE_ALIAS}`,
                );
                attached = true;
            }
            const tables =
                input.source.database === undefined
                    ? emptyLegacyRuntimeTables()
                    : await loadLegacyRuntimeTables({
                          client: input.runtime.client,
                          alias: LEGACY_DATABASE_ALIAS,
                          sourcePath: input.source.database.path,
                      });
            const expectedLedger = createExpectedMigrationLedger(
                input.source,
                tables.map((table) => table.manifest),
            );
            const existing = await readMigrationLedgerRow(input.runtime.client, input.source.migrationId);
            if (existing !== undefined) {
                if (!migrationLedgerMatches(existing, expectedLedger)) {
                    throw new RuntimeDbMigrationError({
                        code: 'ledger_mismatch',
                        migrationId: input.source.migrationId,
                        message: `Runtime database migration ${input.source.migrationId} has a changed source manifest`,
                    });
                }
                await input.runtime.client.execute('COMMIT');
                outcome = {
                    sourceManifestSha256: expectedLedger.source_manifest_sha256,
                    changed: false,
                    sessionIds: projectionSessionIdsForTables(tables),
                };
            } else {
                const sessionIds = await copyLegacyRuntimeRows({
                    client: input.runtime.client,
                    tables,
                    runs: input.source.runs,
                });
                await insertMigrationLedgerRow(input.runtime.client, { ...expectedLedger, completed_at: input.now() });
                await input.runtime.client.execute('COMMIT');
                outcome = { sourceManifestSha256: expectedLedger.source_manifest_sha256, changed: true, sessionIds };
            }
        } catch (error: unknown) {
            await rollbackQuietly(input.runtime.client);
            outcome =
                error instanceof RuntimeDbMigrationError
                    ? error
                    : new RuntimeDbMigrationError({
                          code: input.source.database === undefined ? 'transaction_failed' : 'source_db_corrupt',
                          path: input.source.database?.path ?? input.source.rootPath,
                          migrationId: input.source.migrationId,
                          message: `Runtime database migration failed for ${input.source.rootFileUrl}`,
                          cause: error,
                      });
        }
        if (attached) {
            try {
                await input.runtime.client.execute(`DETACH DATABASE ${LEGACY_DATABASE_ALIAS}`);
            } catch (error: unknown) {
                if (!(outcome instanceof RuntimeDbMigrationError)) {
                    outcome = new RuntimeDbMigrationError({
                        code: 'transaction_failed',
                        path: input.source.database?.path ?? input.source.rootPath,
                        migrationId: input.source.migrationId,
                        message: `Failed to detach legacy runtime database for ${input.source.rootFileUrl}`,
                        cause: error,
                    });
                }
            }
        }
        if (outcome instanceof RuntimeDbMigrationError) throw outcome;
        return outcome;
    });
}

async function rebuildSessionProjections(input: {
    readonly runtime: LocalLibsqlDb;
    readonly identity: SessionStoreIdentity;
    readonly sessionIds: readonly string[];
    readonly migrationId: string;
}): Promise<void> {
    if (input.sessionIds.length === 0) return;
    const store = await openSqliteSessionProjectionStore({ url: input.identity.databaseFileUrl });
    try {
        for (const sessionId of input.sessionIds) {
            const envelopes = await readExportEnvelopes({ client: input.runtime.client, sessionId });
            await projectSessionEventsToSqlite({
                store,
                sessionId,
                sourcePath: input.identity.databaseFileUrl,
                envelopes,
            });
        }
    } catch (error: unknown) {
        throw new RuntimeDbMigrationError({
            code: 'projection_rebuild_failed',
            migrationId: input.migrationId,
            message: `Failed to rebuild projections after ${input.migrationId}`,
            cause: error,
        });
    } finally {
        store.close();
    }
}

async function rollbackQuietly(client: Client): Promise<void> {
    try {
        await client.execute('ROLLBACK');
    } catch {}
}

function escapeSqlString(value: string): string {
    return value.replaceAll("'", "''");
}
