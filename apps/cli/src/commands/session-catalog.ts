import {
    createFileSessionIndexStore,
    projectJsonlSessionReplayPrefix,
    type ReplayDiagnostic,
    resolveMissionControlDataDir,
    type SessionIndexDiagnostic,
    type SessionIndexSessionRecord,
    type SessionIndexStore,
} from '@mission-control/core';
import type { AgentSnapshot } from '@mission-control/protocol';
import { type CliSessionLockState, readSessionLockState } from './session-lock-status.js';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
    readonly lockState: CliSessionLockState;
    readonly updatedAt?: string | undefined;
    readonly indexed: boolean;
    readonly indexState: CliSessionCatalogIndexState;
    readonly diagnostics: readonly CliSessionCatalogDiagnostic[];
};

export async function listSessionCatalogEntries(): Promise<readonly CliSessionCatalogEntry[]> {
    const indexState = await readSessionIndexState();
    const ids = new Set<string>(await listJsonlSessionIds());
    for (const record of indexState.records.values()) {
        if (parseSessionId(record.sessionId) !== undefined) {
            ids.add(record.sessionId);
        }
    }
    const entries = await Promise.all([...ids].map((sessionId) => readSessionCatalogEntry(sessionId, indexState)));
    return entries.sort(compareCatalogEntries);
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
            lockState,
            updatedAt: undefined,
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
        lockState,
        updatedAt: canUseIndex ? indexRecord.updatedAt : projection.updatedAt,
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
        `lock=${entry.lockState}`,
        entry.updatedAt === undefined ? undefined : `updated=${entry.updatedAt}`,
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
          readonly updatedAt?: string | undefined;
          readonly diagnostics: readonly ReplayDiagnostic[];
      };

type SessionIndexReadState = {
    readonly records: ReadonlyMap<string, SessionIndexSessionRecord>;
    readonly diagnostics: readonly CliSessionCatalogDiagnostic[];
    readonly store?: SessionIndexStore | undefined;
};

async function readSessionProjection(sessionId: string): Promise<SessionProjectionResult> {
    try {
        const replay = projectJsonlSessionReplayPrefix({
            sessionId,
            contents: await readFile(sessionLogPath(sessionId), 'utf8'),
        });
        const lastEvent = replay.projection.events.at(-1);
        return {
            kind: 'projection',
            snapshot: replay.projection.snapshot,
            eventCount: replay.projection.events.length,
            updatedAt: lastEvent?.timestamp,
            diagnostics: replay.diagnostics,
        };
    } catch (error: unknown) {
        if (isMissingFileError(error)) {
            return { kind: 'missing' };
        }
        throw error;
    }
}

async function readSessionIndexState(): Promise<SessionIndexReadState> {
    try {
        const store = createFileSessionIndexStore({ indexPath: sessionIndexPath() });
        const sessions = await store.listSessions();
        return {
            records: new Map(sessions.map((session) => [session.sessionId, session])),
            diagnostics: [],
            store,
        };
    } catch (error: unknown) {
        if (isMissingFileError(error)) {
            return { records: new Map(), diagnostics: [] };
        }
        if (error instanceof Error) {
            return {
                records: new Map(),
                diagnostics: [corruptIndexDiagnostic()],
            };
        }
        throw error;
    }
}

async function readIndexDiagnosticsForSession(
    sessionId: string,
    indexState: SessionIndexReadState,
): Promise<readonly CliSessionCatalogDiagnostic[]> {
    if (indexState.store === undefined) {
        return [];
    }
    try {
        const diagnostics = await indexState.store.getDiagnostics(sessionId);
        return diagnostics.map(sanitizeIndexDiagnostic);
    } catch (error: unknown) {
        if (isMissingFileError(error)) {
            return [];
        }
        if (error instanceof Error) {
            return [corruptIndexDiagnostic()];
        }
        throw error;
    }
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

function indexStateLabel(hasFreshIndex: boolean, indexState: SessionIndexReadState): CliSessionCatalogIndexState {
    if (indexState.diagnostics.length > 0) {
        return 'corrupt';
    }
    return hasFreshIndex ? 'derived' : 'jsonl';
}

function corruptIndexDiagnostic(): CliSessionCatalogDiagnostic {
    return {
        code: 'corrupt_index',
        sessionId: 'session-index',
        message: 'session index could not be read',
    };
}

function sanitizeIndexDiagnostic(diagnostic: SessionIndexDiagnostic): CliSessionCatalogDiagnostic {
    return {
        code: 'index_diagnostic',
        sessionId: diagnostic.sessionId,
        message: 'session index contains a diagnostic record',
        lineNumber: diagnostic.lineNumber,
    };
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
        .filter((sessionId) => parseSessionId(sessionId) !== undefined);
}

function compareCatalogEntries(left: CliSessionCatalogEntry, right: CliSessionCatalogEntry): number {
    const timeOrder = (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '');
    return timeOrder === 0 ? left.sessionId.localeCompare(right.sessionId) : timeOrder;
}

function requireValidSessionId(sessionId: string): string {
    const parsed = parseSessionId(sessionId);
    if (parsed === undefined) {
        throw new TypeError(`invalid session id: ${sessionId}`);
    }
    return parsed;
}

function parseSessionId(sessionId: string): string | undefined {
    return /^[A-Za-z0-9._-]+$/.test(sessionId) ? sessionId : undefined;
}

function sessionIndexPath(): string {
    return join(resolveMissionControlDataDir(), 'session-index.json');
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
