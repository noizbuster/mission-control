import {
    createFileSessionIndexStore,
    deleteLocalSessionRows,
    resolveMissionControlDataDir,
} from '@mission-control/core';
import { type CliSessionCatalogEntry, listSessionCatalogEntries } from './session-catalog.js';
import { CliSessionCommandError } from './session-command-error.js';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

export async function deleteSessionTree(input: {
    readonly sessionId: string;
    readonly force?: boolean;
}): Promise<string> {
    const targetId = input.sessionId;
    const entries = await listSessionCatalogEntries();
    const target = entries.find((entry) => entry.sessionId === targetId);
    if (target === undefined) {
        throw new CliSessionCommandError({
            code: 'session_not_found',
            message: `Session not found: ${targetId}`,
            sessionId: targetId,
        });
    }

    const childrenByParent = buildChildrenByParent(entries);
    const ordered = collectDescendants(target, childrenByParent);

    if (input.force !== true) {
        const liveLocked = ordered.filter((entry) => entry.lockState === 'live');
        if (liveLocked.length > 0) {
            throw new CliSessionCommandError({
                code: 'session_live_locked',
                message:
                    `Refusing to delete ${liveLocked.length} session(s) with active locks: ` +
                    `${liveLocked.map((entry) => entry.sessionId).join(', ')}. ` +
                    `Close the active session(s) first or rerun with --force.`,
                sessionId: targetId,
            });
        }
    }

    const indexStore = createFileSessionIndexStore({ indexPath: sessionIndexPath() });
    await deleteLocalSessionRows({ sessionIds: ordered.map((entry) => entry.sessionId) });
    await Promise.all(
        ordered.flatMap((entry) => [
            rm(sessionLogPath(entry.sessionId), { force: true }),
            rm(sessionLockPath(entry.sessionId), { force: true }),
            indexStore.replaceSessionIndex({
                sessionId: entry.sessionId,
                records: [],
                diagnostics: [],
            }),
        ]),
    );

    const lines = ordered.map((entry) => `Deleted session ${entry.sessionId} (${entry.eventCount} events)`);
    return `${lines.join('\n')}\n`;
}

function sessionLogsDir(): string {
    return join(resolveMissionControlDataDir(), 'sessions');
}

function sessionLogPath(sessionId: string): string {
    return join(sessionLogsDir(), `${sessionId}.jsonl`);
}

function sessionLockPath(sessionId: string): string {
    return join(sessionLogsDir(), `${sessionId}.lock`);
}

function sessionIndexPath(): string {
    return join(resolveMissionControlDataDir(), 'session-index.json');
}

function buildChildrenByParent(
    entries: readonly CliSessionCatalogEntry[],
): ReadonlyMap<string, readonly CliSessionCatalogEntry[]> {
    const map = new Map<string, CliSessionCatalogEntry[]>();
    for (const entry of entries) {
        if (entry.parentSessionId === undefined) {
            continue;
        }
        const siblings = map.get(entry.parentSessionId);
        if (siblings === undefined) {
            map.set(entry.parentSessionId, [entry]);
        } else {
            siblings.push(entry);
        }
    }
    return map;
}

function collectDescendants(
    target: CliSessionCatalogEntry,
    childrenByParent: ReadonlyMap<string, readonly CliSessionCatalogEntry[]>,
): readonly CliSessionCatalogEntry[] {
    const ordered: CliSessionCatalogEntry[] = [];
    const visited = new Set<string>([target.sessionId]);
    const queue: CliSessionCatalogEntry[] = [target];
    while (queue.length > 0) {
        const current = queue.shift();
        if (current === undefined) {
            break;
        }
        ordered.push(current);
        for (const child of childrenByParent.get(current.sessionId) ?? []) {
            if (!visited.has(child.sessionId)) {
                visited.add(child.sessionId);
                queue.push(child);
            }
        }
    }
    return ordered;
}
