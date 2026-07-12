/**
 * Turso/libSQL-backed persistent working-memory store (ABG §10.4/§12).
 *
 * Implements the SAME `PersistentMemoryStore` interface as `InMemoryPersistentStore` over
 * `@libsql/client` + `drizzle-orm`, so it is a drop-in production backend. It is the
 * intended replacement for the dead `better-sqlite3` adapter (`SqlitePersistentStore`):
 * libSQL ships prebuilt binaries (no node-gyp), speaks the same SQL dialect, and accepts
 * an embedded local `file:` URL (no server, no network) or `:memory:` (for tests). The JSONL
 * event ledger stays untouched — this is only the queryable key/value view whose
 * namespaces map to Blackboard slots.
 *
 * The serialization / TTL / query-matching LOGIC is REUSED verbatim from the pure helpers
 * in `sqlite-persistent-store.ts` so this adapter behaves identically to
 * `InMemoryPersistentStore` and `SqlitePersistentStore` for every observable outcome.
 *
 * DDL is applied by the shared local DB schema initializer so memory and session tables
 * share one local database without adding drizzle-kit.
 */
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import type { LocalLibsqlDb } from '../db/local-libsql-db.js';
import { openLocalLibsqlDb, runLocalLibsqlWrite } from '../db/local-libsql-db.js';
import { memoryEntries } from '../db/schema.js';
import { deserializeValue, entryMatchesQuery, isExpired, serializeValue } from './persistent-memory-helpers.js';
import type { MemoryEntry, MemoryQuery, PersistentMemoryStore } from './persistent-memory-store.js';

type MemoryRow = {
    readonly namespace: string;
    readonly key: string;
    readonly value: string;
    readonly createdAt: string;
    readonly expiresAt: string | null;
};

export class TursoPersistentStore implements PersistentMemoryStore {
    private readonly runtime: LocalLibsqlDb;

    private constructor(runtime: LocalLibsqlDb) {
        this.runtime = runtime;
    }

    static fromRuntime(runtime: LocalLibsqlDb): TursoPersistentStore {
        return new TursoPersistentStore(runtime);
    }

    static async openMemory(): Promise<TursoPersistentStore> {
        return TursoPersistentStore.fromRuntime(await openLocalLibsqlDb({ url: ':memory:' }));
    }

    async get(key: string, namespace: string): Promise<unknown | undefined> {
        const rows = await this.runtime.db
            .select({ value: memoryEntries.value, expiresAt: memoryEntries.expiresAt })
            .from(memoryEntries)
            .where(and(eq(memoryEntries.namespace, namespace), eq(memoryEntries.key, key)));
        const row = rows[0];
        if (row === undefined) {
            return undefined;
        }
        const expiredAt = row.expiresAt;
        if (expiredAt !== null && isExpired({ expiresAt: expiredAt }, Date.now())) {
            await runLocalLibsqlWrite(this.runtime, async () => {
                await this.runtime.db
                    .delete(memoryEntries)
                    .where(
                        and(
                            eq(memoryEntries.namespace, namespace),
                            eq(memoryEntries.key, key),
                            eq(memoryEntries.expiresAt, expiredAt),
                        ),
                    );
            });
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
        await runLocalLibsqlWrite(this.runtime, async () => {
            await this.runtime.db
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
        });
    }

    async list(namespace: string): Promise<readonly MemoryEntry[]> {
        const rows = await this.runtime.db.select().from(memoryEntries).where(eq(memoryEntries.namespace, namespace));
        return rows.map(rowToEntry).filter((entry) => !isExpired(entry, Date.now()));
    }

    async query(query: MemoryQuery): Promise<readonly MemoryEntry[]> {
        const rows = await this.runtime.db.select().from(memoryEntries);
        let results = rows
            .map(rowToEntry)
            .filter((entry) => !isExpired(entry, Date.now()) && entryMatchesQuery(entry, query));
        if (query.k !== undefined) {
            results = results.slice(0, query.k);
        }
        return results;
    }

    async prune(now: string): Promise<number> {
        const deleted = await runLocalLibsqlWrite(this.runtime, () =>
            this.runtime.db
                .delete(memoryEntries)
                .where(and(isNotNull(memoryEntries.expiresAt), lte(memoryEntries.expiresAt, now)))
                .returning(),
        );
        return deleted.length;
    }

    close(): void {
        this.runtime.close();
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
        const probe = await TursoPersistentStore.openMemory();
        probe.close();
        return true;
    } catch {
        return false;
    }
}
