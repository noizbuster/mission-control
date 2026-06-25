/**
 * Turso/libSQL-backed persistent working-memory store (ABG §10.4/§12).
 *
 * Implements the SAME `PersistentMemoryStore` interface as `InMemoryPersistentStore` over
 * `@libsql/client` + `drizzle-orm`, so it is a drop-in production backend. It is the
 * intended replacement for the dead `better-sqlite3` adapter (`SqlitePersistentStore`):
 * libSQL ships prebuilt binaries (no node-gyp), speaks the same SQL dialect, and accepts
 * an embedded `file:` URL (no server, no network) or `:memory:` (for tests). The JSONL
 * event ledger stays untouched — this is only the queryable key/value view whose
 * namespaces map to Blackboard slots.
 *
 * The serialization / TTL / query-matching LOGIC is REUSED verbatim from the pure helpers
 * in `sqlite-persistent-store.ts` so this adapter behaves identically to
 * `InMemoryPersistentStore` and `SqlitePersistentStore` for every observable outcome.
 *
 * DDL uses `CREATE TABLE IF NOT EXISTS` (raw SQL on the libSQL client) rather than the
 * drizzle migrator: the schema is fixed and local, and pulling in drizzle-kit migrations
 * would add toolchain weight this boundary does not need.
 */
import type { Client } from '@libsql/client';
import { createClient } from '@libsql/client';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { memoryEntries } from '../db/schema.js';
import type { MemoryEntry, MemoryQuery, PersistentMemoryStore } from './persistent-memory-store.js';
import {
    deserializeValue,
    entryMatchesQuery,
    isExpired,
    serializeValue,
} from './persistent-memory-helpers.js';

const CREATE_TABLE_SQL = /* sql */ `
    CREATE TABLE IF NOT EXISTS memory_entries (
        namespace  TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        PRIMARY KEY (namespace, key)
    );
`;

type MemoryRow = {
    readonly namespace: string;
    readonly key: string;
    readonly value: string;
    readonly createdAt: string;
    readonly expiresAt: string | null;
};

/**
 * Open (or create) a libSQL-backed store at `url`. Accepts `:memory:` for an ephemeral
 * in-memory DB, `file:./path.db` for an embedded file, or a `libsql://` URL for a remote
 * Turso instance. The table is created on open and the underlying client is held for the
 * life of the store; `close()` releases it.
 */
export class TursoPersistentStore implements PersistentMemoryStore {
    private readonly client: Client;
    private readonly db: LibSQLDatabase<Record<string, never>>;

    private constructor(client: Client) {
        this.client = client;
        this.db = drizzle(client);
    }

    static async open(url: string): Promise<TursoPersistentStore> {
        const client = createClient({ url });
        const store = new TursoPersistentStore(client);
        await client.execute(CREATE_TABLE_SQL);
        return store;
    }

    async get(key: string, namespace: string): Promise<unknown | undefined> {
        const rows = await this.db
            .select({ value: memoryEntries.value, expiresAt: memoryEntries.expiresAt })
            .from(memoryEntries)
            .where(and(eq(memoryEntries.namespace, namespace), eq(memoryEntries.key, key)));
        const row = rows[0];
        if (row === undefined) {
            return undefined;
        }
        if (isExpired({ expiresAt: row.expiresAt ?? undefined }, Date.now())) {
            await this.db
                .delete(memoryEntries)
                .where(and(eq(memoryEntries.namespace, namespace), eq(memoryEntries.key, key)));
            return undefined;
        }
        return deserializeValue(row.value);
    }

    async set(key: string, namespace: string, value: unknown, ttlMs?: number): Promise<void> {
        const now = Date.now();
        const createdAt = new Date(now).toISOString();
        // null (not undefined) so the column receives SQL NULL and the object literal stays
        // compatible with exactOptionalPropertyTypes.
        const expiresAt = ttlMs !== undefined ? new Date(now + ttlMs).toISOString() : null;
        await this.db
            .insert(memoryEntries)
            .values({
                namespace,
                key,
                value: serializeValue(value),
                createdAt,
                expiresAt,
            })
            .onConflictDoUpdate({
                target: [memoryEntries.namespace, memoryEntries.key],
                set: {
                    value: serializeValue(value),
                    createdAt,
                    expiresAt,
                },
            });
    }

    async list(namespace: string): Promise<readonly MemoryEntry[]> {
        const rows = await this.db.select().from(memoryEntries).where(eq(memoryEntries.namespace, namespace));
        return rows.map(rowToEntry).filter((entry) => !isExpired(entry, Date.now()));
    }

    async query(query: MemoryQuery): Promise<readonly MemoryEntry[]> {
        const rows = await this.db.select().from(memoryEntries);
        let results = rows
            .map(rowToEntry)
            .filter((entry) => !isExpired(entry, Date.now()) && entryMatchesQuery(entry, query));
        if (query.k !== undefined) {
            results = results.slice(0, query.k);
        }
        return results;
    }

    async prune(now: string): Promise<number> {
        const deleted = await this.db
            .delete(memoryEntries)
            .where(and(isNotNull(memoryEntries.expiresAt), lte(memoryEntries.expiresAt, now)))
            .returning();
        return deleted.length;
    }

    close(): void {
        this.client.close();
    }
}

function rowToEntry(row: MemoryRow): MemoryEntry {
    return {
        key: row.key,
        namespace: row.namespace,
        value: deserializeValue(row.value),
        createdAt: row.createdAt,
        expiresAt: row.expiresAt ?? undefined,
    };
}

/** Dynamic check: is the libSQL client usable in this environment (embedded probe)? */
export async function isTursoAvailable(): Promise<boolean> {
    try {
        const probe = await TursoPersistentStore.open(':memory:');
        probe.close();
        return true;
    } catch {
        return false;
    }
}
