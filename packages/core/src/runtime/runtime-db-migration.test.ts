import { type Run, RunSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { openCanonicalRuntimeDb, openRuntimeLocalDb, runtimeDbMigrationTableDescriptors } from './local-runtime-db.js';
import { migrateLegacyRuntimeStores } from './runtime-db-migration.js';
import { seedCompleteLegacyDatabase } from './runtime-db-migration-legacy-fixture.js';
import { makeMigrationFixture, rowCount, sha256File, writeLegacyRunJson } from './runtime-db-migration-test-support.js';
import { resolveSessionStoreIdentity, sessionStoreDatabasePath } from './session-store-identity.js';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const AUTHORITATIVE_TABLES = [
    'sessions',
    'missions',
    'session_event_sequences',
    'session_events',
    'mission_runs',
    'session_inputs',
    'session_awaits',
    'context_epochs',
    'session_relations',
    'runtime_agents',
    'async_jobs',
    'legacy_session_imports',
    'memory_entries',
] as const;

describe('runtime database migration', () => {
    it('exports all 13 authoritative descriptors in prescribed copy order', () => {
        expect(runtimeDbMigrationTableDescriptors.map((descriptor) => descriptor.table)).toEqual(AUTHORITATIVE_TABLES);
        expect(runtimeDbMigrationTableDescriptors.every((descriptor) => descriptor.columns.length > 0)).toBe(true);
    });

    it('copies a complete legacy DB, rebuilds projections, preserves inputs, and reruns as a no-op', async () => {
        const { canonicalDataDir, legacyRoot } = await makeMigrationFixture();
        await seedCompleteLegacyDatabase(legacyRoot);
        const legacyRun = RunSchema.parse({
            id: 'json_only_active_run',
            missionId: 'legacy_mission',
            status: 'running',
            startedAt: '2026-07-01T01:00:00.000Z',
        });
        const jsonPath = await writeLegacyRunJson(legacyRoot, legacyRun);
        const sourceDbPath = sessionStoreDatabasePath(legacyRoot);
        const sourceDbBefore = await sha256File(sourceDbPath);
        const sourceJsonBefore = await readFile(jsonPath, 'utf8');

        const first = await openCanonicalRuntimeDb({ legacyRoots: [legacyRoot] });
        first.runtime.close();
        const second = await openCanonicalRuntimeDb({ legacyRoots: [legacyRoot] });
        second.runtime.close();

        const identity = await resolveSessionStoreIdentity({ dataDir: canonicalDataDir });
        const runtime = await openRuntimeLocalDb(identity);
        try {
            for (const table of AUTHORITATIVE_TABLES) {
                expect(await rowCount(runtime.client, table), table).toBeGreaterThan(0);
            }
            expect(await rowCount(runtime.client, 'runtime_db_migration_ledger')).toBe(1);
            expect(await rowCount(runtime.client, 'session_projection_runs')).toBe(1);
            expect(await rowCount(runtime.client, 'session_projection_diagnostics')).toBe(0);
            const jsonOnly = await runtime.client.execute({
                sql: 'SELECT status FROM mission_runs WHERE run_id = ?',
                args: [legacyRun.id],
            });
            expect(jsonOnly.rows).toEqual([{ status: 'running' }]);
        } finally {
            runtime.close();
        }
        expect(await sha256File(sourceDbPath)).toBe(sourceDbBefore);
        expect(await readFile(jsonPath, 'utf8')).toBe(sourceJsonBefore);
    });

    it('rolls back every copied row and the ledger on a differing primary-key collision', async () => {
        const { canonicalDataDir, legacyRoot } = await makeMigrationFixture();
        await seedCompleteLegacyDatabase(legacyRoot);
        const identity = await resolveSessionStoreIdentity({ dataDir: canonicalDataDir });
        const destination = await openRuntimeLocalDb(identity);
        try {
            await destination.client.execute({
                sql: 'INSERT INTO sessions (session_id, status, created_at, updated_at, last_activity_at, title) VALUES (?, ?, ?, ?, ?, ?)',
                args: [
                    'legacy_session',
                    'idle',
                    '2026-07-01T00:00:00.000Z',
                    '2026-07-01T00:00:00.000Z',
                    '2026-07-01T00:00:00.000Z',
                    'conflict',
                ],
            });
        } finally {
            destination.close();
        }

        await expect(openCanonicalRuntimeDb({ legacyRoots: [legacyRoot] })).rejects.toMatchObject({
            code: 'row_collision',
            table: 'sessions',
        });

        const reopened = await openRuntimeLocalDb(identity);
        try {
            expect(await rowCount(reopened.client, 'missions')).toBe(0);
            expect(await rowCount(reopened.client, 'runtime_db_migration_ledger')).toBe(0);
        } finally {
            reopened.close();
        }
    });

    it('detaches the read-only source after a migration failure', async () => {
        const { canonicalDataDir, legacyRoot } = await makeMigrationFixture();
        await seedCompleteLegacyDatabase(legacyRoot);
        const identity = await resolveSessionStoreIdentity({ dataDir: canonicalDataDir });
        const destination = await openRuntimeLocalDb(identity);
        try {
            await destination.client.execute({
                sql: 'INSERT INTO sessions (session_id, status, created_at, updated_at, last_activity_at, title) VALUES (?, ?, ?, ?, ?, ?)',
                args: [
                    'legacy_session',
                    'idle',
                    '2026-07-01T00:00:00.000Z',
                    '2026-07-01T00:00:00.000Z',
                    '2026-07-01T00:00:00.000Z',
                    'conflict',
                ],
            });
            await expect(
                migrateLegacyRuntimeStores({ runtime: destination, identity, legacyRoots: [legacyRoot] }),
            ).rejects.toMatchObject({ code: 'row_collision' });
            const databases = await destination.client.execute('PRAGMA database_list');
            expect(databases.rows.some((row) => row[1] === 'legacy_runtime_store')).toBe(false);
            await expect(destination.client.execute('SELECT 1')).resolves.toBeDefined();
        } finally {
            destination.close();
        }
    });

    it('fails closed on corrupt JSON without mutating destination or source', async () => {
        const { canonicalDataDir, legacyRoot } = await makeMigrationFixture();
        const runsDir = join(legacyRoot, '.omo', 'runs');
        await mkdir(runsDir, { recursive: true });
        const corruptPath = join(runsDir, 'corrupt.json');
        await writeFile(corruptPath, '{ broken', 'utf8');

        await expect(openCanonicalRuntimeDb({ legacyRoots: [legacyRoot] })).rejects.toMatchObject({
            code: 'legacy_run_corrupt',
            path: corruptPath,
        });

        const identity = await resolveSessionStoreIdentity({ dataDir: canonicalDataDir });
        const runtime = await openRuntimeLocalDb(identity);
        try {
            expect(await rowCount(runtime.client, 'mission_runs')).toBe(0);
            expect(await rowCount(runtime.client, 'runtime_db_migration_ledger')).toBe(0);
        } finally {
            runtime.close();
        }
        expect(await readFile(corruptPath, 'utf8')).toBe('{ broken');
    });

    it('rejects a symlinked legacy database instead of following it outside the root', async () => {
        if (process.platform === 'win32') return;
        const { legacyRoot } = await makeMigrationFixture();
        const outsideRoot = join(legacyRoot, '..', 'outside-db-root');
        await mkdir(outsideRoot, { mode: 0o700 });
        await seedCompleteLegacyDatabase(outsideRoot);
        const sourceDbPath = sessionStoreDatabasePath(outsideRoot);
        const linkedDbPath = sessionStoreDatabasePath(legacyRoot);
        await symlink(sourceDbPath, linkedDbPath);

        await expect(openCanonicalRuntimeDb({ legacyRoots: [legacyRoot] })).rejects.toMatchObject({
            code: 'legacy_db_invalid',
            path: linkedDbPath,
        });
    });

    it('rejects symlinked legacy run directories and files', async () => {
        if (process.platform === 'win32') return;
        const { legacyRoot } = await makeMigrationFixture();
        const outsideRoot = join(legacyRoot, '..', 'outside-runs-root');
        const outsideRunsDir = join(outsideRoot, '.omo', 'runs');
        await mkdir(join(legacyRoot, '.omo'), { recursive: true });
        await mkdir(outsideRunsDir, { recursive: true });
        await writeFile(join(outsideRunsDir, 'outside.json'), JSON.stringify(runFixture('outside')), 'utf8');
        const runsDir = join(legacyRoot, '.omo', 'runs');
        await symlink(outsideRunsDir, runsDir);

        await expect(openCanonicalRuntimeDb({ legacyRoots: [legacyRoot] })).rejects.toMatchObject({
            code: 'legacy_run_unsafe',
            path: runsDir,
        });

        const directRoot = join(legacyRoot, '..', 'direct-runs-root');
        const directRunsDir = join(directRoot, '.omo', 'runs');
        await mkdir(directRunsDir, { recursive: true });
        const linkedRunPath = join(directRunsDir, 'linked.json');
        await symlink(join(outsideRunsDir, 'outside.json'), linkedRunPath);
        await expect(openCanonicalRuntimeDb({ legacyRoots: [directRoot] })).rejects.toMatchObject({
            code: 'legacy_run_unsafe',
            path: linkedRunPath,
        });
    });

    it('migrates exact multiple roots and rejects a changed manifest after ledger commit', async () => {
        const { legacyRoot } = await makeMigrationFixture();
        const secondRoot = join(legacyRoot, '..', 'second-root');
        await mkdir(secondRoot, { mode: 0o700 });
        const firstRun = runFixture('first_root_run');
        const secondRun = runFixture('second_root_run');
        const firstPath = await writeLegacyRunJson(legacyRoot, firstRun);
        await writeLegacyRunJson(secondRoot, secondRun);

        const migrated = await openCanonicalRuntimeDb({ legacyRoots: [secondRoot, legacyRoot, legacyRoot] });
        try {
            expect(await rowCount(migrated.runtime.client, 'mission_runs')).toBe(2);
            expect(await rowCount(migrated.runtime.client, 'runtime_db_migration_ledger')).toBe(2);
        } finally {
            migrated.runtime.close();
        }

        await writeFile(firstPath, JSON.stringify({ ...firstRun, status: 'blocked' }), 'utf8');
        await expect(openCanonicalRuntimeDb({ legacyRoots: [legacyRoot] })).rejects.toMatchObject({
            code: 'ledger_mismatch',
        });
    });

    it('creates the complete migration ledger schema', async () => {
        const { canonicalDataDir } = await makeMigrationFixture();
        const identity = await resolveSessionStoreIdentity({ dataDir: canonicalDataDir });
        const runtime = await openRuntimeLocalDb(identity);
        try {
            const columns = await runtime.client.execute('PRAGMA table_info(runtime_db_migration_ledger)');
            expect(columns.rows.map((row) => row[1])).toEqual([
                'migration_id',
                'legacy_db_identity',
                'source_root_file_url',
                'source_db_file_url',
                'source_manifest_sha256',
                'copied_tables_json',
                'legacy_runs_json',
                'completed_at',
            ]);
        } finally {
            runtime.close();
        }
    });
});

function runFixture(id: string): Run {
    return RunSchema.parse({
        id,
        missionId: 'json_mission',
        status: 'running',
        startedAt: '2026-07-01T00:00:00.000Z',
    });
}
