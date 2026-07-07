import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
    LocalDbConfigError,
    LocalDbMigrationError,
    listLocalDbMigrationLedger,
    openLocalLibsqlDb,
    runLocalDbMigrations,
} from './local-libsql-db.js';
import { runtimePersistenceSchemaSql } from './local-libsql-schema-runtime.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

async function tempDbUrl(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mctrl-local-db-'));
    tempDirs.push(dir);
    return `file:${join(dir, 'memory.db')}`;
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('local libSQL database runtime', () => {
    it('records explicit future migrations once when migrations are supplied', async () => {
        const givenUrl = await tempDbUrl();
        const givenMigration = {
            id: '0001_create_widget_table',
            sql: 'CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY)',
        };
        const db = await openLocalLibsqlDb({ url: givenUrl, migrations: [givenMigration] });

        await runLocalDbMigrations(db.client, [givenMigration]);
        const thenLedger = await listLocalDbMigrationLedger(db.client);
        db.close();

        expect(thenLedger).toHaveLength(1);
        expect(thenLedger[0]?.id).toBe('0001_create_widget_table');
    });

    it('keeps memory_entries rows when schema setup runs repeatedly across reopen', async () => {
        const givenUrl = await tempDbUrl();
        const first = await openLocalLibsqlDb({ url: givenUrl });
        await first.client.execute({
            sql: 'INSERT INTO memory_entries (namespace, key, value, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
            args: ['goals', 'ship', '{"ok":true}', '2026-07-06T00:00:00.000Z', null],
        });
        first.close();

        const second = await openLocalLibsqlDb({ url: givenUrl });
        const thenRows = await second.client.execute(
            "SELECT namespace, key, value FROM memory_entries WHERE namespace = 'goals' AND key = 'ship'",
        );
        second.close();

        expect(thenRows.rows).toEqual([{ namespace: 'goals', key: 'ship', value: '{"ok":true}' }]);
    });

    it('creates the documented shared session model tables across reopen', async () => {
        const givenUrl = await tempDbUrl();

        const first = await openLocalLibsqlDb({ url: givenUrl });
        first.close();
        const second = await openLocalLibsqlDb({ url: givenUrl });
        const thenTables = await second.client.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        );
        second.close();

        // biome-ignore lint/complexity/useLiteralKeys: libSQL rows expose table columns through an index signature.
        expect(thenTables.rows.map((row) => row['name'])).toEqual(
            expect.arrayContaining([
                'approvals',
                'async_jobs',
                'context_epochs',
                'legacy_session_imports',
                'memory_entries',
                'mission_runs',
                'missions',
                'provider_failures',
                'runtime_agents',
                'session_awaits',
                'session_event_sequences',
                'session_events',
                'session_inputs',
                'session_messages',
                'session_parts',
                'session_projection_diagnostics',
                'session_projection_runs',
                'session_relations',
                'sessions',
                'tool_calls',
            ]),
        );
    });

    it('migrates legacy session projection table names during schema setup', async () => {
        const givenUrl = await tempDbUrl();
        const legacy = createClient({ url: givenUrl });
        await legacy.batch(
            runtimePersistenceSchemaSql.map((sql) => ({ sql })),
            'write',
        );
        await legacy.batch(
            [
                {
                    sql: `
                        CREATE TABLE session_index_runs (
                            session_id TEXT NOT NULL,
                            event_id TEXT NOT NULL,
                            sequence INTEGER NOT NULL,
                            timestamp TEXT NOT NULL,
                            event_type TEXT NOT NULL,
                            command TEXT,
                            state TEXT,
                            run_id TEXT,
                            input_id TEXT,
                            provider_turn_id TEXT,
                            reason TEXT,
                            error_code TEXT,
                            PRIMARY KEY (session_id, event_id)
                        )
                    `,
                },
                {
                    sql: `
                        CREATE TABLE session_index_diagnostics (
                            session_id TEXT NOT NULL,
                            file_path TEXT NOT NULL,
                            code TEXT NOT NULL,
                            message TEXT NOT NULL,
                            line_number INTEGER,
                            PRIMARY KEY (session_id, file_path, code, message)
                        )
                    `,
                },
                {
                    sql:
                        'INSERT INTO sessions (session_id, status, last_event_seq, created_at, updated_at, last_activity_at) ' +
                        'VALUES (?, ?, ?, ?, ?, ?)',
                    args: [
                        'session_legacy_projection',
                        'running',
                        1,
                        '2026-07-07T00:00:00.000Z',
                        '2026-07-07T00:00:00.000Z',
                        '2026-07-07T00:00:00.000Z',
                    ],
                },
                {
                    sql:
                        'INSERT INTO session_index_runs ' +
                        '(session_id, event_id, sequence, timestamp, event_type, command, state, run_id, input_id, provider_turn_id, reason, error_code) ' +
                        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    args: [
                        'session_legacy_projection',
                        'event_1',
                        0,
                        '2026-07-07T00:00:00.000Z',
                        'run.completed',
                        'run',
                        'completed',
                        'run_1',
                        null,
                        null,
                        null,
                        null,
                    ],
                },
                {
                    sql:
                        'INSERT INTO session_index_diagnostics (session_id, file_path, code, message, line_number) ' +
                        'VALUES (?, ?, ?, ?, ?)',
                    args: ['session_legacy_projection', '/tmp/session.jsonl', 'legacy_warning', 'legacy warning', 7],
                },
            ],
            'write',
        );
        legacy.close();

        const db = await openLocalLibsqlDb({ url: givenUrl });
        const migratedRun = await db.client.execute('SELECT event_id FROM session_projection_runs');
        const migratedDiagnostic = await db.client.execute('SELECT code FROM session_projection_diagnostics');
        const legacyTables = await db.client.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'session_index_%' ORDER BY name",
        );
        db.close();

        expect(migratedRun.rows).toEqual([{ event_id: 'event_1' }]);
        expect(migratedDiagnostic.rows).toEqual([{ code: 'legacy_warning' }]);
        expect(legacyTables.rows).toEqual([]);
    });

    it('rejects remote libSQL URLs before opening a client', async () => {
        const whenOpening = openLocalLibsqlDb({ url: 'libsql://user:secret@example.turso.io/app?token=secret' });

        await expect(whenOpening).rejects.toMatchObject({
            code: 'remote_url',
            scheme: 'libsql',
        } satisfies Partial<LocalDbConfigError>);
        await expect(whenOpening).rejects.not.toThrow(/secret|example\.turso\.io/u);
    });

    it('rejects malformed explicit migration ids', async () => {
        const givenClient = createClient({ url: ':memory:' });

        await expect(
            runLocalDbMigrations(givenClient, [{ id: 'bad id', sql: 'CREATE TABLE bad_id (id TEXT PRIMARY KEY)' }]),
        ).rejects.toMatchObject({
            code: 'invalid_migration_id',
        } satisfies Partial<LocalDbMigrationError>);
        givenClient.close();
    });

    it('rejects duplicate explicit migration ids', async () => {
        const givenClient = createClient({ url: ':memory:' });
        const first = { id: '0001_duplicate', sql: 'CREATE TABLE first_table (id TEXT PRIMARY KEY)' };
        const second = { id: '0001_duplicate', sql: 'CREATE TABLE second_table (id TEXT PRIMARY KEY)' };

        await expect(runLocalDbMigrations(givenClient, [first, second])).rejects.toMatchObject({
            code: 'duplicate_migration_id',
        } satisfies Partial<LocalDbMigrationError>);
        givenClient.close();
    });

    it('rejects explicit migration checksum drift', async () => {
        const givenClient = createClient({ url: ':memory:' });
        await runLocalDbMigrations(givenClient, [
            { id: '0001_checksum', sql: 'CREATE TABLE checksum_one (id TEXT PRIMARY KEY)' },
        ]);

        await expect(
            runLocalDbMigrations(givenClient, [
                { id: '0001_checksum', sql: 'CREATE TABLE checksum_two (id TEXT PRIMARY KEY)' },
            ]),
        ).rejects.toMatchObject({
            code: 'migration_checksum_mismatch',
        } satisfies Partial<LocalDbMigrationError>);
        givenClient.close();
    });
});
