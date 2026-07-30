import type { Client } from '@libsql/client';
import type { MissionControlDrizzleDb } from './drizzle-client';
import {
    bindLocalLibsqlWriteLane,
    createLocalLibsqlWriteLane,
    type LocalLibsqlWriteLane,
    quarantineLocalLibsqlWriteLane,
} from './local-libsql-write-lane';

export type LocalLibsqlRegistryResource = {
    readonly client: Client;
    readonly db: MissionControlDrizzleDb;
};

export type LocalLibsqlRegistryLease = LocalLibsqlRegistryResource & {
    readonly close: () => void;
};

export type AcquireLocalLibsqlFileLeaseOptions = {
    readonly key: string;
    readonly setupKey: string;
    readonly createClient: () => Client;
    readonly createDatabase: (client: Client) => MissionControlDrizzleDb;
    readonly initialize: (client: Client) => Promise<void>;
};

type LocalLibsqlRegistryEntry = {
    readonly key: string;
    readonly initialization: Promise<LocalLibsqlRegistryResource>;
    readonly setupPromises: Map<string, Promise<LocalLibsqlRegistryResource>>;
    readonly writeLane: LocalLibsqlWriteLane;
    references: number;
    closeToken: symbol | undefined;
    closed: boolean;
    quarantined: boolean;
};

const fileEntries = new Map<string, LocalLibsqlRegistryEntry>();
const entriesByClient = new WeakMap<Client, LocalLibsqlRegistryEntry>();

export function quarantineLocalLibsqlClient(client: Client): void {
    quarantineLocalLibsqlWriteLane(client);
    const entry = entriesByClient.get(client);
    if (entry === undefined) {
        client.close();
        return;
    }
    entry.quarantined = true;
    entry.closeToken = undefined;
    if (fileEntries.get(entry.key) === entry) fileEntries.delete(entry.key);
    void entry.initialization.then((resource) => closeResource(entry, resource));
}

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

function existingOrNewEntry(options: AcquireLocalLibsqlFileLeaseOptions): LocalLibsqlRegistryEntry {
    const existing = fileEntries.get(options.key);
    if (existing !== undefined) return existing;

    let entry: LocalLibsqlRegistryEntry | undefined;
    const writeLane = createLocalLibsqlWriteLane();
    const initialization = Promise.resolve().then(async () => {
        let client: Client | undefined;
        try {
            client = options.createClient();
            bindLocalLibsqlWriteLane({ writeKey: options.key, client }, writeLane);
            if (entry !== undefined) entriesByClient.set(client, entry);
            await options.initialize(client);
            return { client, db: options.createDatabase(client) };
        } catch (error: unknown) {
            if (client !== undefined) {
                entriesByClient.delete(client);
                client.close();
            }
            if (entry !== undefined && fileEntries.get(options.key) === entry) fileEntries.delete(options.key);
            throw error;
        }
    });
    entry = {
        key: options.key,
        initialization,
        setupPromises: new Map([[options.setupKey, initialization]]),
        writeLane,
        references: 0,
        closeToken: undefined,
        closed: false,
        quarantined: false,
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

function releaseFileLease(entry: LocalLibsqlRegistryEntry): void {
    entry.references--;
    if (entry.references > 0 || entry.quarantined) return;
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
            closeResource(entry, resource);
        });
    });
}

function closeResource(entry: LocalLibsqlRegistryEntry, resource: LocalLibsqlRegistryResource): void {
    if (entry.closed) return;
    entry.closed = true;
    entriesByClient.delete(resource.client);
    resource.client.close();
}
