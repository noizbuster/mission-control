import {
    normalizeWorkspaceRoot,
    ProjectTrustStore,
    type ReplayDiagnostic,
    resolveMissionControlDataDir,
    type SessionIndexSessionRecord,
} from '@mission-control/core';
import type { AgentSnapshot } from '@mission-control/protocol';
import {
    indexStateLabel,
    readIndexDiagnosticsForSession,
    readSessionIndexState,
    type SessionIndexReadState,
} from './session-catalog-index.js';
import { deriveSessionCatalogProjection } from './session-catalog-projection.js';
import { parseCliSessionId } from './session-id.js';
import { type CliSessionLockState, readSessionLockState } from './session-lock-status.js';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type CliSessionListStatus = AgentSnapshot['status'] | 'corrupt' | 'missing';
export type CliSessionCatalogIndexState = 'derived' | 'jsonl' | 'corrupt';
export type CliSessionCatalogDiagnostic =
    | ReplayDiagnostic
    | {
          readonly code: 'corrupt_index' | 'index_diagnostic';
          readonly sessionId: string;
          readonly message: string;
          readonly lineNumber?: number | undefined;
      };

export type CliSessionCatalogEntry = {
    readonly sessionId: string;
    readonly status: CliSessionListStatus;
    readonly eventCount: number;
    readonly messageCount: number;
    readonly lockState: CliSessionLockState;
    readonly createdAt?: string | undefined;
    readonly updatedAt?: string | undefined;
    readonly cwd?: string | undefined;
    readonly trustedRoot?: string | undefined;
    readonly name?: string | undefined;
    readonly activeLeafId?: string | undefined;
    readonly parentSessionId?: string | undefined;
    readonly trustStatus: 'trusted' | 'denied' | 'unknown';
    readonly indexed: boolean;
    readonly indexState: CliSessionCatalogIndexState;
    readonly diagnostics: readonly CliSessionCatalogDiagnostic[];
};

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

// Both `entries[].cwd|trustedRoot` and `normalizedWorkspaceRoot` must be
// realpath-resolved before calling; a naive `===` silently misses symlinks.
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

async function normalizeWorkspaceRootWithFallback(workspaceRoot: string): Promise<string> {
    try {
        return await normalizeWorkspaceRoot(workspaceRoot);
    } catch {
        return resolve(workspaceRoot);
    }
}

export async function readSessionCatalogEntry(
    sessionId: string,
    indexState?: SessionIndexReadState,
): Promise<CliSessionCatalogEntry> {
    const parsedSessionId = requireValidSessionId(sessionId);
    const resolvedIndexState = indexState ?? (await readSessionIndexState());
    const indexRecord = resolvedIndexState.records.get(parsedSessionId);
    const [projection, lockState] = await Promise.all([
        readSessionProjection(parsedSessionId),
        readSessionLockState({
            sessionId: parsedSessionId,
            lockPath: join(sessionLogsDir(), `${parsedSessionId}.lock`),
        }),
    ]);
    const indexDiagnostics = await readIndexDiagnosticsForSession(parsedSessionId, resolvedIndexState);
    if (projection.kind === 'missing') {
        return {
            sessionId: parsedSessionId,
            status: 'missing',
            eventCount: 0,
            messageCount: 0,
            lockState,
            createdAt: undefined,
            updatedAt: undefined,
            cwd: undefined,
            trustedRoot: undefined,
            name: undefined,
            activeLeafId: undefined,
            parentSessionId: undefined,
            trustStatus: 'unknown',
            indexed: false,
            indexState: indexStateLabel(false, resolvedIndexState),
            diagnostics: [...resolvedIndexState.diagnostics, ...indexDiagnostics],
        };
    }
    const hasDiagnostics = projection.diagnostics.length > 0;
    const canUseIndex = indexRecord !== undefined && !hasDiagnostics && isFreshIndexRecord(indexRecord, projection);
    return {
        sessionId: parsedSessionId,
        status: hasDiagnostics ? 'corrupt' : projection.snapshot.status,
        eventCount: projection.eventCount,
        messageCount: projection.messageCount,
        lockState,
        createdAt: projection.createdAt,
        updatedAt: canUseIndex ? indexRecord.updatedAt : projection.updatedAt,
        cwd: projection.cwd,
        trustedRoot: projection.trustedRoot,
        name: projection.name,
        activeLeafId: projection.activeLeafId,
        parentSessionId: projection.parentSessionId,
        trustStatus: await readTrustStatus(projection.workspaceTrust, projection.trustedRoot ?? projection.cwd),
        indexed: canUseIndex,
        indexState: indexStateLabel(canUseIndex, resolvedIndexState),
        diagnostics: [...projection.diagnostics, ...resolvedIndexState.diagnostics, ...indexDiagnostics],
    };
}

export function formatSessionCatalogEntry(entry: CliSessionCatalogEntry): string {
    return [
        entry.sessionId,
        `status=${entry.status}`,
        `events=${entry.eventCount}`,
        `messages=${entry.messageCount}`,
        `lock=${entry.lockState}`,
        entry.createdAt === undefined ? undefined : `created=${entry.createdAt}`,
        entry.updatedAt === undefined ? undefined : `updated=${entry.updatedAt}`,
        entry.cwd === undefined ? undefined : `cwd=${entry.cwd}`,
        entry.name === undefined ? undefined : `name=${entry.name}`,
        entry.activeLeafId === undefined ? undefined : `active=${entry.activeLeafId}`,
        `trust=${entry.trustStatus}`,
        entry.parentSessionId === undefined ? undefined : `parent=${entry.parentSessionId}`,
        `index=${entry.indexState}`,
        entry.diagnostics.length === 0 ? undefined : `diagnostics=${entry.diagnostics.length}`,
    ]
        .filter((part) => part !== undefined)
        .join('\t');
}

type SessionProjectionResult =
    | { readonly kind: 'missing' }
    | {
          readonly kind: 'projection';
          readonly snapshot: AgentSnapshot;
          readonly eventCount: number;
          readonly messageCount: number;
          readonly createdAt?: string | undefined;
          readonly updatedAt?: string | undefined;
          readonly cwd?: string | undefined;
          readonly trustedRoot?: string | undefined;
          readonly workspaceTrust?: 'trusted' | 'denied' | 'unknown';
          readonly name?: string | undefined;
          readonly activeLeafId?: string | undefined;
          readonly parentSessionId?: string | undefined;
          readonly diagnostics: readonly ReplayDiagnostic[];
      };

async function readSessionProjection(sessionId: string): Promise<SessionProjectionResult> {
    try {
        const projection = deriveSessionCatalogProjection({
            sessionId,
            contents: await readFile(sessionLogPath(sessionId), 'utf8'),
        });
        return {
            kind: 'projection',
            snapshot: {
                sessionId,
                status: projection.status === 'corrupt' ? 'running' : projection.status,
                startedAt: projection.createdAt ?? new Date(0).toISOString(),
                runningTaskCount: 0,
                completedTaskCount: 0,
                failedTaskCount: 0,
                nativeSidecarStatus: 'unknown',
            },
            eventCount: projection.eventCount,
            messageCount: projection.messageCount,
            createdAt: projection.createdAt,
            updatedAt: projection.updatedAt,
            cwd: projection.cwd,
            trustedRoot: projection.trustedRoot,
            ...(projection.workspaceTrust !== undefined ? { workspaceTrust: projection.workspaceTrust } : {}),
            name: projection.name,
            activeLeafId: projection.activeLeafId,
            parentSessionId: projection.parentSessionId,
            diagnostics: projection.diagnostics,
        };
    } catch (error: unknown) {
        if (isMissingFileError(error)) {
            return { kind: 'missing' };
        }
        throw error;
    }
}

async function readTrustStatus(
    durableTrust: 'trusted' | 'denied' | 'unknown' | undefined,
    workspaceRoot: string | undefined,
): Promise<'trusted' | 'denied' | 'unknown'> {
    if (durableTrust !== undefined) {
        return durableTrust;
    }
    if (workspaceRoot === undefined) {
        return 'unknown';
    }
    return new ProjectTrustStore().getDecision(workspaceRoot).then((trust) => trust.decision);
}

function isFreshIndexRecord(
    record: SessionIndexSessionRecord,
    projection: Extract<SessionProjectionResult, { readonly kind: 'projection' }>,
): boolean {
    if (record.eventCount !== projection.eventCount) {
        return false;
    }
    return projection.updatedAt !== undefined && record.updatedAt >= projection.updatedAt;
}

async function listJsonlSessionIds(): Promise<readonly string[]> {
    let entries: readonly string[];
    try {
        entries = await readdir(sessionLogsDir());
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

function requireValidSessionId(sessionId: string): string {
    const parsed = parseCliSessionId(sessionId);
    if (parsed === undefined) {
        throw new TypeError(`invalid session id: ${sessionId}`);
    }
    return parsed;
}

function sessionLogsDir(): string {
    return join(resolveMissionControlDataDir(), 'sessions');
}

function sessionLogPath(sessionId: string): string {
    return join(sessionLogsDir(), `${sessionId}.jsonl`);
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error && Reflect.get(error, 'code') === 'ENOENT';
}
