import { formatSessionStatusWithSource } from '../ui/session-status-format.js';
import type { CliSessionCatalogEntry } from './session-catalog-types.js';

export function formatSessionCatalogEntry(entry: CliSessionCatalogEntry): string {
    return [
        entry.sessionId,
        `status=${formatSessionStatusWithSource(entry)}`,
        `events=${entry.eventCount}`,
        `messages=${entry.messageCount}`,
        entry.createdAt === undefined ? undefined : `created=${entry.createdAt}`,
        entry.updatedAt === undefined ? undefined : `updated=${entry.updatedAt}`,
        entry.cwd === undefined ? undefined : `cwd=${entry.cwd}`,
        entry.name === undefined ? undefined : `name=${entry.name}`,
        entry.activeLeafId === undefined ? undefined : `active=${entry.activeLeafId}`,
        `trust=${entry.trustStatus}`,
        entry.parentSessionId === undefined ? undefined : `parent=${entry.parentSessionId}`,
        entry.diagnostics.length === 0 ? undefined : `diagnostics=${entry.diagnostics.length}`,
    ]
        .filter((part) => part !== undefined)
        .join('\t');
}
