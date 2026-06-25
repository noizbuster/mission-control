/**
 * Pure (binding-free) helpers for persistent working-memory stores (ABG §10.4/§12).
 *
 * Extracted from `sqlite-persistent-store.ts` so every persistent adapter
 * (`SqlitePersistentStore`, `TursoPersistentStore`, future backends) shares ONE
 * implementation of serialization / TTL / query-matching. Keeping these out of the
 * SQLite-specific file also means importing them does not drag the dead
 * `better-sqlite3` adapter (and its ambient module declaration) into consuming
 * TypeScript programs.
 */
import type { MemoryEntry, MemoryQuery } from './persistent-memory-store.js';

/** JSON-serialize a value; non-serializable values fall back to a String() envelope. */
export function serializeValue(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return JSON.stringify({ __nonSerialisable: true, repr: String(value) });
    }
}

/** Parse a stored value back; a malformed blob returns undefined. */
export function deserializeValue(blob: string): unknown {
    try {
        return JSON.parse(blob);
    } catch {
        return undefined;
    }
}

/** True if the entry has expired by `nowMs` (entries without expiresAt never expire). */
export function isExpired(entry: Pick<MemoryEntry, 'expiresAt'>, nowMs: number): boolean {
    return entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= nowMs;
}

/** Substring query match against key + stringified value (matches InMemoryPersistentStore). */
export function entryMatchesQuery(entry: MemoryEntry, query: MemoryQuery): boolean {
    if (query.namespace !== undefined && entry.namespace !== query.namespace) {
        return false;
    }
    if (query.text !== undefined) {
        const haystack = `${entry.key}\n${serializeValue(entry.value)}`;
        if (!haystack.includes(query.text)) {
            return false;
        }
    }
    return true;
}
