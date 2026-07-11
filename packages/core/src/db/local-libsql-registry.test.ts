import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLocalLibsqlDb, runWithLocalLibsqlWriteLock } from './local-libsql-db.js';
import { acquireLocalLibsqlFileLease } from './local-libsql-registry.js';
import { deferred, TestInitializationError } from './local-libsql-registry-test-support.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleMocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    drizzle: vi.fn(),
    ensureLocalDbSchema: vi.fn(),
}));

vi.mock('@libsql/client', () => ({ createClient: moduleMocks.createClient }));
vi.mock('drizzle-orm/libsql', () => ({ drizzle: moduleMocks.drizzle }));
vi.mock('./local-libsql-schema.js', () => ({ ensureLocalDbSchema: moduleMocks.ensureLocalDbSchema }));

type MockClient = {
    readonly close: ReturnType<typeof vi.fn>;
};

const tempDirectories: string[] = [];
const createdClients: MockClient[] = [];

beforeEach(() => {
    vi.clearAllMocks();
    createdClients.length = 0;
    moduleMocks.createClient.mockImplementation(() => {
        const client = { close: vi.fn() };
        createdClients.push(client);
        return client;
    });
    moduleMocks.drizzle.mockImplementation(() => ({ marker: Symbol('drizzle') }));
    moduleMocks.ensureLocalDbSchema.mockResolvedValue(undefined);
});

afterEach(async () => {
    await settleScheduledClose();
    await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('local libSQL process registry', () => {
    it('coalesces twenty concurrent alias opens into one client and Drizzle pair', async () => {
        // Given: twenty concurrent opens name one file through supported aliases while initialization is held.
        const directory = await makeTempDirectory();
        const databasePath = join(directory, 'shared.db');
        const canonicalUrl = pathToFileURL(databasePath).href;
        const aliases = [
            `file:${databasePath}`,
            canonicalUrl,
            canonicalUrl.replace('file:///', 'file://localhost/'),
            `file:${join(directory, 'missing', '..', 'shared.db')}`,
        ];
        const initialization = deferred();
        const initializationStarted = deferred();
        moduleMocks.ensureLocalDbSchema.mockImplementation(() => {
            initializationStarted.resolve();
            return initialization.promise;
        });

        // When: every alias open overlaps the same initialization.
        const opening = Array.from({ length: 20 }, (_value, index) =>
            openLocalLibsqlDb({ url: aliases[index % aliases.length] ?? canonicalUrl }),
        );
        await initializationStarted.promise;
        initialization.resolve();
        const leases = await Promise.all(opening);

        try {
            // Then: all leases share one physical pair, and only final release closes it.
            expect(moduleMocks.createClient).toHaveBeenCalledTimes(1);
            expect(moduleMocks.drizzle).toHaveBeenCalledTimes(1);
            expect(new Set(leases.map((lease) => lease.client)).size).toBe(1);
            expect(new Set(leases.map((lease) => lease.db)).size).toBe(1);
            for (const lease of leases.slice(0, 19)) lease.close();
            await settleScheduledClose();
            expect(createdClients[0]?.close).not.toHaveBeenCalled();
            leases[19]?.close();
            await settleScheduledClose();
            expect(createdClients[0]?.close).toHaveBeenCalledTimes(1);
        } finally {
            for (const lease of leases) lease.close();
        }
    });

    it('makes each file lease close idempotent', async () => {
        // Given: one lease owns the final reference to a file client.
        const lease = await openLocalLibsqlDb({ url: await makeDatabaseUrl('double-close') });

        // When: that same lease is closed twice.
        lease.close();
        lease.close();
        await settleScheduledClose();

        // Then: the physical client closes once.
        expect(createdClients[0]?.close).toHaveBeenCalledTimes(1);
    });

    it('evicts failed initialization so every waiter sees the original error and retry succeeds', async () => {
        // Given: concurrent opens encounter one typed initialization failure.
        const key = await makeDatabaseUrl('failed-init');
        const failure = new TestInitializationError('schema setup failed');
        const initialization = deferred();
        const acquisition = {
            key,
            setupKey: 'failed-init',
            createClient: moduleMocks.createClient,
            createDatabase: moduleMocks.drizzle,
            initialize: () => initialization.promise,
        };

        // When: both waiters fail, then a later caller retries.
        const opening = [acquireLocalLibsqlFileLease(acquisition), acquireLocalLibsqlFileLease(acquisition)];
        initialization.reject(failure);
        const failures = await Promise.allSettled(opening);
        for (const result of failures) {
            expect(result.status).toBe('rejected');
            if (result.status === 'rejected') expect(result.reason).toBe(failure);
        }
        const retried = await acquireLocalLibsqlFileLease({
            ...acquisition,
            initialize: async () => undefined,
        });
        retried.close();
        await settleScheduledClose();

        // Then: one poisoned client was closed and retry created one fresh client.
        expect(moduleMocks.createClient).toHaveBeenCalledTimes(2);
        expect(createdClients[0]?.close).toHaveBeenCalledTimes(1);
        expect(createdClients[1]?.close).toHaveBeenCalledTimes(1);
    });

    it('delays final physical close until a held write drains', async () => {
        // Given: the final lease has a running write in its registry-owned lane.
        const lease = await openLocalLibsqlDb({ url: await makeDatabaseUrl('held-write') });
        const started = deferred();
        const release = deferred();
        const writing = runWithLocalLibsqlWriteLock(lease, async () => {
            started.resolve();
            await release.promise;
        });
        await started.promise;

        try {
            // When: the final lease releases while the write is held.
            lease.close();
            await settleScheduledClose();

            // Then: physical close waits for the write tail.
            expect(createdClients[0]?.close).not.toHaveBeenCalled();
        } finally {
            release.resolve();
            await writing;
        }
        await settleScheduledClose();
        expect(createdClients[0]?.close).toHaveBeenCalledTimes(1);
    });

    it('cancels a pending final close when reopened before write drain', async () => {
        // Given: one file lease releases while a write remains held.
        const url = await makeDatabaseUrl('reopen-before-drain');
        const first = await openLocalLibsqlDb({ url });
        const started = deferred();
        const release = deferred();
        const writing = runWithLocalLibsqlWriteLock(first, async () => {
            started.resolve();
            await release.promise;
        });
        await started.promise;
        first.close();

        // When: a new lease opens before the write tail drains.
        const reopened = await acquireLocalLibsqlFileLease({
            key: first.url,
            setupKey: 'schema',
            createClient: () => {
                throw new TestInitializationError('unexpected client creation');
            },
            createDatabase: () => {
                throw new TestInitializationError('unexpected Drizzle creation');
            },
            initialize: async () => {
                throw new TestInitializationError('unexpected initialization');
            },
        });
        try {
            expect(reopened.client).toBe(first.client);
            release.resolve();
            await writing;
            await settleScheduledClose();

            // Then: the reused live client remains open for the new lease.
            expect(createdClients[0]?.close).not.toHaveBeenCalled();
        } finally {
            release.resolve();
            await writing;
            reopened.close();
        }
        await settleScheduledClose();
        expect(createdClients[0]?.close).toHaveBeenCalledTimes(1);
    });

    it('creates a fresh client when reopened after final close drains', async () => {
        // Given: the final file lease has fully drained and physically closed.
        const url = await makeDatabaseUrl('reopen-after-drain');
        const first = await openLocalLibsqlDb({ url });
        first.close();
        await settleScheduledClose();

        // When: the file is reopened after drain.
        const reopened = await openLocalLibsqlDb({ url });
        try {
            // Then: a fresh physical client backs the new lease.
            expect(reopened.client).not.toBe(first.client);
            expect(moduleMocks.createClient).toHaveBeenCalledTimes(2);
        } finally {
            reopened.close();
        }
        await settleScheduledClose();
        expect(createdClients[0]?.close).toHaveBeenCalledTimes(1);
        expect(createdClients[1]?.close).toHaveBeenCalledTimes(1);
    });

    it('keeps memory opens independent', async () => {
        // Given: two in-memory databases are opened in one process.
        const first = await openLocalLibsqlDb({ url: ':memory:' });
        const second = await openLocalLibsqlDb({ url: ':memory:' });

        // When: the first memory lease closes.
        first.close();

        // Then: clients and Drizzle objects are isolated and the second remains open.
        expect(first.client).not.toBe(second.client);
        expect(first.db).not.toBe(second.db);
        expect(createdClients[0]?.close).toHaveBeenCalledTimes(1);
        expect(createdClients[1]?.close).not.toHaveBeenCalled();
        second.close();
        expect(createdClients[1]?.close).toHaveBeenCalledTimes(1);
    });

    it('closes a memory client when Drizzle construction fails', async () => {
        // Given: memory schema setup succeeds but Drizzle construction fails.
        const failure = new TestInitializationError('Drizzle construction failed');
        moduleMocks.drizzle.mockImplementationOnce(() => {
            throw failure;
        });

        // When: the isolated memory database is opened.
        const opening = openLocalLibsqlDb({ url: ':memory:' });

        // Then: the original error escapes and the created client closes once.
        await expect(opening).rejects.toBe(failure);
        expect(createdClients[0]?.close).toHaveBeenCalledTimes(1);
    });

    it('delays memory client close until its held write drains', async () => {
        // Given: one isolated memory database has a running write.
        const lease = await openLocalLibsqlDb({ url: ':memory:' });
        const started = deferred();
        const release = deferred();
        const writing = runWithLocalLibsqlWriteLock(lease, async () => {
            started.resolve();
            await release.promise;
        });
        await started.promise;

        try {
            // When: the memory lease closes while the write is held.
            lease.close();
            await settleScheduledClose();

            // Then: physical close waits for the isolated write tail.
            expect(createdClients[0]?.close).not.toHaveBeenCalled();
        } finally {
            release.resolve();
            await writing;
        }
        await settleScheduledClose();
        expect(createdClients[0]?.close).toHaveBeenCalledTimes(1);
    });
});

async function makeTempDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'mctrl-local-registry-'));
    tempDirectories.push(directory);
    return directory;
}

async function makeDatabaseUrl(name: string): Promise<string> {
    return `file:${join(await makeTempDirectory(), `${name}.db`)}`;
}

async function settleScheduledClose(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}
