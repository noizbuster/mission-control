/**
 * SQLite-backed persistent working-memory store (ABG §10.4/§12, Phase 8 deferred item).
 *
 * Implements the SAME `PersistentMemoryStore` interface as `InMemoryPersistentStore` over
 * `better-sqlite3`, so it is a drop-in production backend (the JSONL event ledger is
 * untouched — this is the queryable key/value view whose namespaces map to Blackboard slots).
 *
 * NATIVE-BINDING GATE: `better-sqlite3` ships a native `.node` binding that must be compiled
 * (or a prebuilt fetched) for the host node ABI. The adapter is loaded via a DYNAMIC import
 * (`createSqlitePersistentStore`) so the core build/typecheck/tests — which use
 * `InMemoryPersistentStore` — never require the binding. Callers that need persistence call
 * the factory; if the binding is missing it rejects with a clear error rather than crashing
 * import resolution.
 *
 * The serialization / TTL / query-matching LOGIC is extracted into pure helpers below so it
 * is unit-tested WITHOUT the native binding (the binding only gates the DB round-trip).
 */
import type { MemoryEntry, MemoryQuery, PersistentMemoryStore } from './persistent-memory-store.js';

// The pure helpers live in `persistent-memory-helpers.ts` (binding-free, shared with
// TursoPersistentStore). Imported for local use and re-exported to preserve this module's
// historical public API.
import {
    deserializeValue,
    entryMatchesQuery,
    isExpired,
    serializeValue,
} from './persistent-memory-helpers.js';
export { deserializeValue, entryMatchesQuery, isExpired, serializeValue };

/**
 * Minimal structural types for the `better-sqlite3` surface this adapter uses. `better-sqlite3`
 * is an OPERATOR-SUPPLIED runtime dependency (a native module): it is intentionally NOT a
 * manifest dependency of `@mission-control/core` (a dependency guard gates that — the JSONL
 * ledger remains the source of truth, ABG §12). The dynamic `import('better-sqlite3')` in
 * `SqlitePersistentStore.open` resolves it from the operator's deployment; if it is absent,
 * `isSqliteAvailable()` reports false and consumers use `InMemoryPersistentStore`. The
 * ambient type declaration lives in `better-sqlite3.d.ts`.
 */
type SqliteDatabase = import('better-sqlite3').Database;
type SqliteStatement = import('better-sqlite3').Statement;

// ---- SQLite adapter ----

const SCHEMA = /* sql */ `
    CREATE TABLE IF NOT EXISTS memory_entries (
        namespace  TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        PRIMARY KEY (namespace, key)
    );
`;

/**
 * Open (or create) a SQLite-backed store at `dbPath` (`:memory:` for an ephemeral DB). The
 * DB is opened once and statements are precompiled. `close()` releases the handle.
 */
export class SqlitePersistentStore implements PersistentMemoryStore {
    private readonly db: SqliteDatabase;
    private readonly upsert: SqliteStatement;
    private readonly selectOne: SqliteStatement;
    private readonly listNs: SqliteStatement;
    private readonly deleteOne: SqliteStatement;
    private readonly selectExpired: SqliteStatement;
    private readonly selectAll: SqliteStatement;

    private constructor(db: SqliteDatabase) {
        this.db = db;
        db.exec(SCHEMA);
        this.upsert = db.prepare(
            'INSERT INTO memory_entries (namespace, key, value, created_at, expires_at) VALUES (?, ?, ?, ?, ?) ' +
                'ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at, expires_at = excluded.expires_at',
        );
        this.selectOne = db.prepare('SELECT value, expires_at FROM memory_entries WHERE namespace = ? AND key = ?');
        this.listNs = db.prepare(
            'SELECT key, namespace, value, created_at, expires_at FROM memory_entries WHERE namespace = ?',
        );
        this.deleteOne = db.prepare('DELETE FROM memory_entries WHERE namespace = ? AND key = ?');
        this.selectExpired = db.prepare(
            'SELECT namespace, key FROM memory_entries WHERE expires_at IS NOT NULL AND expires_at <= ?',
        );
        this.selectAll = db.prepare('SELECT key, namespace, value, created_at, expires_at FROM memory_entries');
    }

    static async open(dbPath: string): Promise<SqlitePersistentStore> {
        // Dynamic import: keeps the native binding out of the core import graph. The factory
        // is the only place the binding is required, so a missing/broken build never breaks
        // consumers that use InMemoryPersistentStore.
        const betterSqlite3 = (await import('better-sqlite3')).default;
        return new SqlitePersistentStore(new betterSqlite3(dbPath));
    }

    async get(key: string, namespace: string): Promise<unknown | undefined> {
        const row = this.selectOne.get(namespace, key) as { value: string; expires_at: string | null } | undefined;
        if (row === undefined) {
            return undefined;
        }
        if (isExpired({ expiresAt: row.expires_at ?? undefined }, Date.now())) {
            this.deleteOne.run(namespace, key);
            return undefined;
        }
        return deserializeValue(row.value);
    }

    async set(key: string, namespace: string, value: unknown, ttlMs?: number): Promise<void> {
        const now = Date.now();
        const createdAt = new Date(now).toISOString();
        const expiresAt = ttlMs !== undefined ? new Date(now + ttlMs).toISOString() : null;
        this.upsert.run(namespace, key, serializeValue(value), createdAt, expiresAt);
    }

    async list(namespace: string): Promise<readonly MemoryEntry[]> {
        const rows = this.listNs.all(namespace) as readonly Row[];
        return rows.map(rowToEntry).filter((entry) => !isExpired(entry, Date.now()));
    }

    async query(query: MemoryQuery): Promise<readonly MemoryEntry[]> {
        let results = (this.selectAll.all() as readonly Row[])
            .map(rowToEntry)
            .filter((entry) => !isExpired(entry, Date.now()) && entryMatchesQuery(entry, query));
        if (query.k !== undefined) {
            results = results.slice(0, query.k);
        }
        return results;
    }

    async prune(now: string): Promise<number> {
        const expired = this.selectExpired.all(now) as readonly { namespace: string; key: string }[];
        let removed = 0;
        for (const row of expired) {
            this.deleteOne.run(row.namespace, row.key);
            removed += 1;
        }
        return removed;
    }

    close(): void {
        this.db.close();
    }
}

type Row = {
    readonly key: string;
    readonly namespace: string;
    readonly value: string;
    readonly created_at: string;
    readonly expires_at: string | null;
};

function rowToEntry(row: Row): MemoryEntry {
    return {
        key: row.key,
        namespace: row.namespace,
        value: deserializeValue(row.value),
        createdAt: row.created_at,
        expiresAt: row.expires_at ?? undefined,
    };
}

/** Dynamic check: is the better-sqlite3 native binding usable in this environment? */
export async function isSqliteAvailable(): Promise<boolean> {
    try {
        const mod = await import('better-sqlite3');
        const Database = mod.default;
        const probe = new Database(':memory:');
        probe.close();
        return true;
    } catch {
        return false;
    }
}
