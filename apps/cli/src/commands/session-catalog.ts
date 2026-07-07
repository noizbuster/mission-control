import { resolveMissionControlDataDir } from '@mission-control/core';
import { normalizeWorkspaceRootWithFallback, readSessionCatalogEntry } from './session-catalog-entry.js';
import { readSessionIndexState } from './session-catalog-index.js';
import type { CliSessionCatalogEntry } from './session-catalog-types.js';
import { parseCliSessionId } from './session-id.js';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export { readSessionCatalogEntry } from './session-catalog-entry.js';
export { formatSessionCatalogEntry } from './session-catalog-format.js';
export type {
    CliSessionCatalogDiagnostic,
    CliSessionCatalogEntry,
    CliSessionCatalogIndexState,
    CliSessionListStatus,
} from './session-catalog-types.js';

export async function listSessionCatalogEntries(): Promise<readonly CliSessionCatalogEntry[]> {
    const indexState = await readSessionIndexState();
    const ids = new Set<string>(await listJsonlSessionIds());
    for (const record of indexState.records.values()) {
        if (parseCliSessionId(record.sessionId) !== undefined) {
            ids.add(record.sessionId);
        }
    }
    const entries = await Promise.all([...ids].map((sessionId) => readSessionCatalogEntry(sessionId, indexState)));
    return entries.sort(compareCatalogEntries);
}

export function filterCatalogEntriesByWorkspace(
    entries: readonly CliSessionCatalogEntry[],
    normalizedWorkspaceRoot: string,
): readonly CliSessionCatalogEntry[] {
    return entries.filter(
        (entry) => entry.cwd === normalizedWorkspaceRoot || entry.trustedRoot === normalizedWorkspaceRoot,
    );
}

export async function listSessionCatalogEntriesForWorkspace(
    workspaceRoot: string,
): Promise<readonly CliSessionCatalogEntry[]> {
    const normalizedRoot = await normalizeWorkspaceRootWithFallback(workspaceRoot);
    const entries = await listSessionCatalogEntries();
    return filterCatalogEntriesByWorkspace(entries, normalizedRoot);
}

async function listJsonlSessionIds(): Promise<readonly string[]> {
    let entries: readonly string[];
    try {
        entries = await readdir(join(resolveMissionControlDataDir(), 'sessions'));
    } catch (error: unknown) {
        if (isMissingFileError(error)) {
            return [];
        }
        throw error;
    }
    return entries
        .filter((entry) => entry.endsWith('.jsonl'))
        .map((entry) => entry.slice(0, -'.jsonl'.length))
        .filter((sessionId) => parseCliSessionId(sessionId) !== undefined);
}

function compareCatalogEntries(left: CliSessionCatalogEntry, right: CliSessionCatalogEntry): number {
    const timeOrder = (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '');
    return timeOrder === 0 ? left.sessionId.localeCompare(right.sessionId) : timeOrder;
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error && Reflect.get(error, 'code') === 'ENOENT';
}
