/**
 * Persistent working-memory store (ABG §10.4, Phase 8).
 *
 * Distinct from the event-ledger `MemoryStore` (the immutable JSONL trail): this is the
 * queryable key/value working memory whose namespaces map to Blackboard slots
 * (`goals`, `observations`, `artifacts`, `decisions`). The ledger stays the source of truth;
 * this store holds the derived, queryable view that survives across runs.
 *
 * Phase 8 keystone: the operations contract (`get`/`set`/`list`/`query`/`prune` with TTL).
 * `InMemoryPersistentStore` is the testable default; a SQLite-backed adapter
 * (`better-sqlite3`) implements the same interface for production persistence — swapping it in
 * changes nothing upstream (the JSONL ledger is untouched, ABG §12).
 */
export type MemoryNamespace = 'goals' | 'observations' | 'artifacts' | 'decisions' | (string & {});

export type MemoryEntry = {
    readonly key: string;
    readonly namespace: string;
    readonly value: unknown;
    readonly createdAt: string;
    readonly expiresAt: string | undefined;
};

export type MemoryQuery = {
    readonly namespace?: string;
    /** Substring match against the key (and stringified value). */
    readonly text?: string;
    readonly k?: number;
};

export interface PersistentMemoryStore {
    get(key: string, namespace: string): Promise<unknown | undefined>;
    set(key: string, namespace: string, value: unknown, ttlMs?: number): Promise<void>;
    list(namespace: string): Promise<readonly MemoryEntry[]>;
    query(query: MemoryQuery): Promise<readonly MemoryEntry[]>;
    /** Remove expired entries; return the count removed. */
    prune(now: string): Promise<number>;
}

export class InMemoryPersistentStore implements PersistentMemoryStore {
    private readonly entries = new Map<string, MemoryEntry>();

    private entryKey(namespace: string, key: string): string {
        return `${namespace}::${key}`;
    }

    async get(key: string, namespace: string): Promise<unknown | undefined> {
        return this.entries.get(this.entryKey(namespace, key))?.value;
    }

    async set(key: string, namespace: string, value: unknown, ttlMs?: number): Promise<void> {
        const now = Date.now();
        const createdAt = new Date(now).toISOString();
        const expiresAt = ttlMs !== undefined ? new Date(now + ttlMs).toISOString() : undefined;
        this.entries.set(this.entryKey(namespace, key), { key, namespace, value, createdAt, expiresAt });
    }

    async list(namespace: string): Promise<readonly MemoryEntry[]> {
        return [...this.entries.values()].filter((entry) => entry.namespace === namespace);
    }

    async query(query: MemoryQuery): Promise<readonly MemoryEntry[]> {
        let results = [...this.entries.values()];
        if (query.namespace !== undefined) {
            results = results.filter((entry) => entry.namespace === query.namespace);
        }
        if (query.text !== undefined) {
            const needle = query.text;
            results = results.filter((entry) => entry.key.includes(needle) || stringify(entry.value).includes(needle));
        }
        if (query.k !== undefined) {
            results = results.slice(0, query.k);
        }
        return results;
    }

    async prune(now: string): Promise<number> {
        const nowMs = Date.parse(now);
        let removed = 0;
        for (const [compositeKey, entry] of this.entries) {
            if (entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= nowMs) {
                this.entries.delete(compositeKey);
                removed += 1;
            }
        }
        return removed;
    }
}

function stringify(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
