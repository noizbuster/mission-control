/**
 * Runtime wiring seam for the persistent working-memory store (ABG §10.4/§12).
 *
 * `createPersistentStore` is the single production call site that decides whether the
 * runtime gets a durable libSQL-backed store (`TursoPersistentStore`) or runs without
 * one. It probes the libSQL native binary via `isTursoAvailable()` and, on success,
 * opens an embedded `file:` database at `<dataDir>/memory.db` (no server, no network).
 *
 * libSQL/Turso is NEVER mandatory: when the probe fails, the open fails, or the native
 * binary is unavailable, this resolves `undefined` and the caller continues with its
 * existing in-memory behavior (the per-run `Blackboard` stays the working memory; the
 * JSONL event ledger is never touched). The factory itself never throws.
 *
 * The optional `probeAvailability` / `openStore` seams default to the real libSQL probe
 * and opener; tests inject them to assert availability, fallback, and path resolution
 * deterministically without touching disk.
 */
import { join } from 'node:path';
import type { PersistentMemoryStore } from './persistent-memory-store.js';
import { isTursoAvailable, TursoPersistentStore } from './turso-persistent-store.js';

const MEMORY_DB_FILENAME = 'memory.db';

/** Opens a libSQL-backed store at a `file:` (or `:memory:`) URL. Overridable for tests. */
export type PersistentStoreOpener = (url: string) => Promise<PersistentMemoryStore>;

/** Probes whether the libSQL native binary is usable in this environment. Overridable for tests. */
export type TursoAvailabilityProbe = () => Promise<boolean>;

export type CreatePersistentStoreOptions = {
    readonly probeAvailability?: TursoAvailabilityProbe;
    readonly openStore?: PersistentStoreOpener;
};

/**
 * Resolve the runtime's persistent memory store for `dataDir`.
 *
 * Returns a live store backed by `<dataDir>/memory.db` when libSQL is available, otherwise
 * `undefined` (the runtime then runs in-memory-only). Never throws: a failed probe or open
 * is treated as "unavailable" so callers can fall back silently.
 */
export async function createPersistentStore(
    dataDir: string,
    options: CreatePersistentStoreOptions = {},
): Promise<PersistentMemoryStore | undefined> {
    const probe = options.probeAvailability ?? isTursoAvailable;
    const openStore = options.openStore ?? ((url) => TursoPersistentStore.open(url));

    try {
        const available = await probe();
        if (!available) return undefined;
    } catch {
        return undefined;
    }

    const dbUrl = `file:${join(dataDir, MEMORY_DB_FILENAME)}`;
    try {
        return await openStore(dbUrl);
    } catch {
        return undefined;
    }
}
