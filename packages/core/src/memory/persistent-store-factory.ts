/**
 * Runtime wiring seam for the persistent working-memory store (ABG §10.4/§12).
 *
 * `createPersistentStore` is the single production call site that decides whether the
 * runtime gets a durable libSQL-backed store (`TursoPersistentStore`) or runs without
 * one. It probes the libSQL native binary via `isTursoAvailable()` and, on success,
 * opens the embedded Mission Control database under `dataDir` (no server, no network).
 *
 * libSQL/Turso is NEVER mandatory: when the probe fails, a generic open fails, or the native
 * binary is unavailable, this resolves `undefined` and the caller continues with its
 * existing in-memory behavior (the per-run `Blackboard` stays the working memory; the
 * JSONL event ledger is never touched). Typed local configuration and initialization
 * failures propagate instead of silently disabling persistence.
 *
 * The optional `probeAvailability` / `openStore` seams default to the real libSQL probe
 * and opener; tests inject them to assert availability, fallback, and path resolution
 * deterministically without touching disk.
 */

import { LocalDbConfigError, LocalDbInitializationError } from '../db/local-libsql-db.js';
import { openMissionControlDb } from '../db/mission-control-db.js';
import type { PersistentMemoryStore } from './persistent-memory-store.js';
import { isTursoAvailable, TursoPersistentStore } from './turso-persistent-store.js';

export type PersistentStoreOpener = (dataDir: string) => Promise<PersistentMemoryStore>;

/** Probes whether the libSQL native binary is usable in this environment. Overridable for tests. */
export type TursoAvailabilityProbe = () => Promise<boolean>;

export type CreatePersistentStoreOptions = {
    readonly probeAvailability?: TursoAvailabilityProbe;
    readonly openStore?: PersistentStoreOpener;
};

/**
 * Resolve the runtime's persistent memory store for `dataDir`.
 *
 * Returns a live durable store when libSQL is available, otherwise `undefined` so the runtime
 * can continue in-memory-only. Typed local configuration and initialization failures propagate.
 */
export async function createPersistentStore(
    dataDir: string,
    options: CreatePersistentStoreOptions = {},
): Promise<PersistentMemoryStore | undefined> {
    const probe = options.probeAvailability ?? isTursoAvailable;
    const openStore =
        options.openStore ??
        (async (storeDataDir: string) =>
            TursoPersistentStore.fromRuntime(await openMissionControlDb({ dataDir: storeDataDir })));

    try {
        const available = await probe();
        if (!available) return undefined;
    } catch {
        return undefined;
    }

    try {
        return await openStore(dataDir);
    } catch (error: unknown) {
        if (error instanceof LocalDbConfigError || error instanceof LocalDbInitializationError) throw error;
        return undefined;
    }
}
