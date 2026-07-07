import { normalizeWorkspaceRootWithFallback, readSessionCatalogEntry } from './session-catalog-entry.js';
import { readSessionIndexState } from './session-catalog-index.js';
import type { CliSessionCatalogEntry } from './session-catalog-types.js';
import { parseCliSessionId } from './session-id.js';

export { readSessionCatalogEntry } from './session-catalog-entry.js';
export { formatSessionCatalogEntry } from './session-catalog-format.js';
export type {
    CliSessionCatalogDiagnostic,
    CliSessionCatalogEntry,
    CliSessionListStatus,
} from './session-catalog-types.js';

export async function listSessionCatalogEntries(): Promise<readonly CliSessionCatalogEntry[]> {
    const indexState = await readSessionIndexState();
    const ids = [...indexState.records.values()]
        .map((record) => record.sessionId)
        .filter((sessionId) => parseCliSessionId(sessionId) !== undefined);
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

function compareCatalogEntries(left: CliSessionCatalogEntry, right: CliSessionCatalogEntry): number {
    const timeOrder = (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '');
    return timeOrder === 0 ? left.sessionId.localeCompare(right.sessionId) : timeOrder;
}
