import type { Client } from '@libsql/client';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { LocalLibsqlWriteKey } from './local-libsql-identity.js';

export type LocalLibsqlRegistryResource = {
    readonly client: Client;
    readonly db: LibSQLDatabase<Record<string, never>>;
};

export type LocalLibsqlRegistryLease = LocalLibsqlRegistryResource & {
    readonly close: () => void;
};

export type AcquireLocalLibsqlFileLeaseOptions = {
    readonly key: string;
    readonly setupKey: string;
    readonly createClient: () => Client;
    readonly createDatabase: (client: Client) => LibSQLDatabase<Record<string, never>>;
    readonly initialize: (client: Client) => Promise<void>;
};

type WriteLane = {
    tail: Promise<void>;
};

type LocalLibsqlRegistryEntry = {
    readonly key: string;
    readonly initialization: Promise<LocalLibsqlRegistryResource>;
    readonly setupPromises: Map<string, Promise<LocalLibsqlRegistryResource>>;
    readonly writeLane: WriteLane;
    references: number;
    closeToken: symbol | undefined;
};

const fileEntries = new Map<string, LocalLibsqlRegistryEntry>();
const isolatedWriteLanes = new Map<LocalLibsqlWriteKey, WriteLane>();

export async function acquireLocalLibsqlFileLease(
    options: AcquireLocalLibsqlFileLeaseOptions,
): Promise<LocalLibsqlRegistryLease> {
    const entry = existingOrNewEntry(options);
    entry.references++;
    entry.closeToken = undefined;
    let resource: LocalLibsqlRegistryResource;
    try {
        resource = await setupForLease(entry, options);
    } catch (error: unknown) {
        if (fileEntries.get(entry.key) === entry) releaseFileLease(entry);
        throw error;
    }
    let released = false;

    return {
        ...resource,
        close: () => {
            if (released) return;
            released = true;
            releaseFileLease(entry);
        },
    };
}

export function closeIsolatedLocalLibsqlAfterWrites(writeKey: LocalLibsqlWriteKey, close: () => void): void {
    const writeLane = isolatedWriteLanes.get(writeKey);
    if (writeLane === undefined) {
        close();
        return;
    }
    scheduleIsolatedClose(writeLane, close);
}

export async function runWithLocalLibsqlRegistryWriteLock<T>(
    writeKey: LocalLibsqlWriteKey,
    write: () => Promise<T>,
): Promise<T> {
    const entry = typeof writeKey === 'string' ? fileEntries.get(writeKey) : undefined;
    const writeLane = entry?.writeLane ?? existingOrNewIsolatedWriteLane(writeKey);
    const previous = writeLane.tail;
    let releaseQueue = (): void => undefined;
    const current = new Promise<void>((resolve) => {
        releaseQueue = resolve;
    });
    const queued = previous.then(() => current);
    writeLane.tail = queued;
    await previous;

    try {
        return await write();
    } finally {
        releaseQueue();
        if (entry === undefined && isolatedWriteLanes.get(writeKey)?.tail === queued) {
            isolatedWriteLanes.delete(writeKey);
        }
    }
}

function existingOrNewEntry(options: AcquireLocalLibsqlFileLeaseOptions): LocalLibsqlRegistryEntry {
    const existing = fileEntries.get(options.key);
    if (existing !== undefined) return existing;

    let entry: LocalLibsqlRegistryEntry | undefined;
    const initialization = Promise.resolve().then(async () => {
        let client: Client | undefined;
        try {
            client = options.createClient();
            await options.initialize(client);
            return { client, db: options.createDatabase(client) };
        } catch (error: unknown) {
            client?.close();
            if (entry !== undefined && fileEntries.get(options.key) === entry) fileEntries.delete(options.key);
            throw error;
        }
    });
    const writeLane = isolatedWriteLanes.get(options.key) ?? { tail: Promise.resolve() };
    isolatedWriteLanes.delete(options.key);
    entry = {
        key: options.key,
        initialization,
        setupPromises: new Map([[options.setupKey, initialization]]),
        writeLane,
        references: 0,
        closeToken: undefined,
    };
    fileEntries.set(options.key, entry);
    return entry;
}

function setupForLease(
    entry: LocalLibsqlRegistryEntry,
    options: AcquireLocalLibsqlFileLeaseOptions,
): Promise<LocalLibsqlRegistryResource> {
    const existing = entry.setupPromises.get(options.setupKey);
    if (existing !== undefined) return existing;

    const pending = entry.initialization.then(async (resource) => {
        await options.initialize(resource.client);
        return resource;
    });
    entry.setupPromises.set(options.setupKey, pending);
    void pending.catch(() => {
        if (entry.setupPromises.get(options.setupKey) === pending) entry.setupPromises.delete(options.setupKey);
    });
    return pending;
}

function existingOrNewIsolatedWriteLane(writeKey: LocalLibsqlWriteKey): WriteLane {
    const existing = isolatedWriteLanes.get(writeKey);
    if (existing !== undefined) return existing;
    const created = { tail: Promise.resolve() };
    isolatedWriteLanes.set(writeKey, created);
    return created;
}

function releaseFileLease(entry: LocalLibsqlRegistryEntry): void {
    entry.references--;
    if (entry.references > 0) return;
    scheduleFinalClose(entry);
}

function scheduleFinalClose(entry: LocalLibsqlRegistryEntry): void {
    const closeToken = Symbol('local-libsql-final-close');
    const scheduledTail = entry.writeLane.tail;
    entry.closeToken = closeToken;
    void scheduledTail.then(() => {
        void entry.initialization.then((resource) => {
            if (entry.references !== 0 || entry.closeToken !== closeToken || fileEntries.get(entry.key) !== entry)
                return;
            if (entry.writeLane.tail !== scheduledTail) {
                scheduleFinalClose(entry);
                return;
            }
            fileEntries.delete(entry.key);
            resource.client.close();
        });
    });
}

function scheduleIsolatedClose(writeLane: WriteLane, close: () => void): void {
    const scheduledTail = writeLane.tail;
    void scheduledTail.then(() => {
        if (writeLane.tail !== scheduledTail) {
            scheduleIsolatedClose(writeLane, close);
            return;
        }
        close();
    });
}
