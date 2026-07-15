import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tempDirectories: string[] = [];

afterEach(async () => {
    vi.doUnmock('@libsql/client');
    vi.doUnmock('drizzle-orm/libsql');
    vi.doUnmock('./local-libsql-schema.js');
    vi.resetModules();
    await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('local libSQL initialization baseline', () => {
    it('creates the shared schema when opening a file database', async () => {
        // Given: an isolated path for a new local file database.
        const directory = await mkdtemp(join(tmpdir(), 'mctrl-local-pragmas-baseline-'));
        tempDirectories.push(directory);

        // When: the normal local database opener initializes the file.
        const { openLocalLibsqlDb } = await import('./local-libsql-db.js');
        const runtime = await openLocalLibsqlDb({ url: `file:${join(directory, 'baseline.db')}` });
        const table = await runtime.client.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries'",
        );
        runtime.close();

        // Then: schema initialization remains part of the open contract.
        expect(table.rows).toEqual([{ name: 'memory_entries' }]);
    });

    it('keeps an in-memory database in memory journal mode', async () => {
        // Given: one isolated in-memory database.
        const { openLocalLibsqlDb } = await import('./local-libsql-db.js');
        const runtime = await openLocalLibsqlDb({ url: ':memory:' });

        // When: its journal mode is queried after initialization.
        const journalMode = await runtime.client.execute('PRAGMA journal_mode');
        runtime.close();

        // Then: memory initialization does not require file-only WAL mode.
        expect(journalMode.rows).toEqual([{ journal_mode: 'memory' }]);
    });

    it.each(['memory', 'file'] as const)('enables and enforces foreign keys for a %s database', async (kind) => {
        // Given: a real database opened through the normal memory or file path.
        const { openLocalLibsqlDb } = await import('./local-libsql-db.js');
        const url = kind === 'memory' ? ':memory:' : `file:${join(await makeTempDirectory(), 'foreign-keys.db')}`;
        const runtime = await openLocalLibsqlDb({ url });

        // When: the connection reports its setting and an orphaned approval effect is inserted.
        const foreignKeys = await runtime.client.execute('PRAGMA foreign_keys');
        const orphanInsert = runtime.client.execute({
            sql:
                'INSERT INTO desktop_approval_effects ' +
                '(session_id,approval_id,run_id,tool_call_id,tool_name,arguments_json,workspace_root,state,requested_at) ' +
                'VALUES (?,?,?,?,?,?,?,?,?)',
            args: [
                'missing_session',
                'approval_orphan',
                'run_orphan',
                'call_orphan',
                'command.run',
                '{}',
                '/',
                'pending',
                new Date().toISOString(),
            ],
        });

        // Then: foreign keys are active and the orphan is rejected by SQLite itself.
        expect(foreignKeys.rows).toEqual([{ foreign_keys: 1 }]);
        await expect(orphanInsert).rejects.toThrow(/FOREIGN KEY constraint failed/u);
        runtime.close();
    });
});

describe('local libSQL file PRAGMAs', () => {
    it('configures the client timeout and runs PRAGMAs before schema setup', async () => {
        // Given: a traced file-client initialization seam.
        const trace: string[] = [];
        const fixture = await installMockedDatabaseModules({ trace });
        const databasePath = join(await makeTempDirectory(), 'ordered.db');
        const canonicalUrl = pathToFileURL(databasePath).href;

        // When: the file database is opened through the normal runtime path.
        const runtime = await fixture.openLocalLibsqlDb({ url: `file:${databasePath}` });
        runtime.close();

        // Then: the bounded client is configured and PRAGMAs precede schema writes.
        expect(fixture.createClient).toHaveBeenCalledWith({ url: canonicalUrl, timeout: 5000 });
        expect(trace).toEqual([
            'PRAGMA foreign_keys=ON',
            'PRAGMA foreign_keys',
            'PRAGMA journal_mode=WAL',
            'PRAGMA synchronous=NORMAL',
            'PRAGMA journal_mode',
            'PRAGMA synchronous',
            'PRAGMA busy_timeout',
            'schema',
        ]);
    });

    it('fails closed on WAL refusal, evicts the entry, and permits retry', async () => {
        // Given: the first physical client refuses WAL and the replacement accepts it.
        const trace: string[] = [];
        const fixture = await installMockedDatabaseModules({ trace, walModes: ['delete', 'wal'] });
        const url = `file:${join(await makeTempDirectory(), 'wal-refusal.db')}`;

        // When: initialization fails and a later caller retries the same canonical file.
        const refused = fixture.openLocalLibsqlDb({ url });
        await expect(refused).rejects.toMatchObject({
            name: 'LocalDbInitializationError',
            code: 'wal_refused',
            pragma: 'journal_mode',
            expected: 'wal',
            actual: 'delete',
        });
        const retried = await fixture.openLocalLibsqlDb({ url });
        retried.close();
        await settleScheduledClose();

        // Then: the poisoned client and successful retry each close exactly once.
        expect(fixture.createClient).toHaveBeenCalledTimes(2);
        expect(fixture.clients[0]?.close).toHaveBeenCalledTimes(1);
        expect(fixture.clients[1]?.close).toHaveBeenCalledTimes(1);
    });

    it('fails closed when a verified PRAGMA has an unexpected value', async () => {
        // Given: WAL succeeds but the synchronous verification reports FULL.
        const trace: string[] = [];
        const fixture = await installMockedDatabaseModules({ trace, synchronous: 2 });
        const url = `file:${join(await makeTempDirectory(), 'unexpected-sync.db')}`;

        // When: initialization verifies the configured PRAGMA values.
        const opening = fixture.openLocalLibsqlDb({ url });

        // Then: the typed initialization error preserves the precise mismatch.
        await expect(opening).rejects.toMatchObject({
            name: 'LocalDbInitializationError',
            code: 'unexpected_pragma_value',
            pragma: 'synchronous',
            expected: 1,
            actual: 2,
        });
        expect(fixture.clients[0]?.close).toHaveBeenCalledTimes(1);
    });

    it('persists WAL, NORMAL synchronous mode, and the bounded busy timeout in a real file', async () => {
        // Given: an isolated path for a real local file database.
        const databasePath = join(await makeTempDirectory(), 'pragmas.db');
        const { openLocalLibsqlDb } = await import('./local-libsql-db.js');

        // When: file initialization completes before the schema is queried.
        const runtime = await openLocalLibsqlDb({ url: `file:${databasePath}` });
        const journalMode = await runtime.client.execute('PRAGMA journal_mode');
        const synchronous = await runtime.client.execute('PRAGMA synchronous');
        const busyTimeout = await runtime.client.execute('PRAGMA busy_timeout');
        const memoryTable = await runtime.client.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries'",
        );
        runtime.close();

        // Then: the file invariants and schema are all observable after open.
        expect(journalMode.rows).toEqual([{ journal_mode: 'wal' }]);
        expect(synchronous.rows).toEqual([{ synchronous: 1 }]);
        expect(busyTimeout.rows).toEqual([{ timeout: 5000 }]);
        expect(memoryTable.rows).toEqual([{ name: 'memory_entries' }]);
    });
});

type MockClient = {
    readonly execute: ReturnType<typeof vi.fn>;
    readonly close: ReturnType<typeof vi.fn>;
};

type MockedDatabaseOptions = {
    readonly trace: string[];
    readonly walModes?: readonly string[];
    readonly synchronous?: number;
};

async function installMockedDatabaseModules(options: MockedDatabaseOptions) {
    const clients: MockClient[] = [];
    const createClient = vi.fn(() => {
        const clientIndex = clients.length;
        const walMode = options.walModes?.[clientIndex] ?? 'wal';
        const client: MockClient = {
            execute: vi.fn(async (sql: string) => {
                options.trace.push(sql);
                if (sql === 'PRAGMA journal_mode=WAL' || sql === 'PRAGMA journal_mode') {
                    return { rows: [{ 0: walMode, journal_mode: walMode, length: 1 }] };
                }
                if (sql === 'PRAGMA foreign_keys') return { rows: [{ foreign_keys: 1 }] };
                if (sql === 'PRAGMA synchronous') return { rows: [{ synchronous: options.synchronous ?? 1 }] };
                if (sql === 'PRAGMA busy_timeout') return { rows: [{ timeout: 5000 }] };
                return { rows: [] };
            }),
            close: vi.fn(),
        };
        clients.push(client);
        return client;
    });
    vi.doMock('@libsql/client', () => ({ createClient }));
    vi.doMock('drizzle-orm/libsql', () => ({ drizzle: vi.fn(() => ({ marker: 'drizzle' })) }));
    vi.doMock('./local-libsql-schema.js', () => ({
        ensureLocalDbSchema: vi.fn(async () => {
            options.trace.push('schema');
        }),
    }));
    vi.resetModules();
    const { openLocalLibsqlDb } = await import('./local-libsql-db.js');
    return { clients, createClient, openLocalLibsqlDb };
}

async function makeTempDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'mctrl-local-pragmas-'));
    tempDirectories.push(directory);
    return directory;
}

async function settleScheduledClose(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}
