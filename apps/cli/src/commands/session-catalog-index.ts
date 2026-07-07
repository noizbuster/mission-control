import {
    createFileSessionIndexStore,
    createLocalSessionIndexStore,
    localSessionDbPath,
    resolveMissionControlDataDir,
    type SessionIndexDiagnostic,
    type SessionIndexSessionRecord,
    type SessionIndexStore,
} from '@mission-control/core';
import type { CliSessionCatalogDiagnostic, CliSessionCatalogIndexState } from './session-catalog.js';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

export type SessionIndexReadState = {
    readonly source: 'file' | 'sqlite';
    readonly records: ReadonlyMap<string, SessionIndexSessionRecord>;
    readonly diagnostics: readonly CliSessionCatalogDiagnostic[];
    readonly store?: SessionIndexStore | undefined;
    readonly diagnosticStore?: SessionIndexStore | undefined;
};

export async function readSessionIndexState(): Promise<SessionIndexReadState> {
    try {
        const dataDir = resolveMissionControlDataDir();
        if (await localSessionDbExists(dataDir)) {
            const localState = await readStoreIndexState(await createLocalSessionIndexStore({ dataDir }));
            const fileState = await readFileIndexState(dataDir);
            if (localState.records.size > 0) {
                return {
                    ...localState,
                    ...(fileState?.store !== undefined ? { diagnosticStore: fileState.store } : {}),
                };
            }
            return fileState ?? localState;
        }
        return (await readFileIndexState(dataDir)) ?? { source: 'file', records: new Map(), diagnostics: [] };
    } catch (error: unknown) {
        if (isMissingFileError(error)) {
            return { source: 'file', records: new Map(), diagnostics: [] };
        }
        if (error instanceof Error) {
            return {
                source: 'file',
                records: new Map(),
                diagnostics: [corruptIndexDiagnostic()],
            };
        }
        throw error;
    }
}

async function readFileIndexState(dataDir: string): Promise<SessionIndexReadState | undefined> {
    try {
        return await readFileStoreIndexState(createFileSessionIndexStore({ indexPath: sessionIndexPath(dataDir) }));
    } catch (error: unknown) {
        if (isMissingFileError(error)) {
            return undefined;
        }
        throw error;
    }
}

async function readStoreIndexState(store: SessionIndexStore): Promise<SessionIndexReadState> {
    const sessions = await store.listSessions();
    return {
        source: 'sqlite',
        records: new Map(sessions.map((session) => [session.sessionId, session])),
        diagnostics: [],
        store,
    };
}

async function readFileStoreIndexState(store: SessionIndexStore): Promise<SessionIndexReadState> {
    const sessions = await store.listSessions();
    return {
        source: 'file',
        records: new Map(sessions.map((session) => [session.sessionId, session])),
        diagnostics: [],
        store,
    };
}

export async function readIndexDiagnosticsForSession(
    sessionId: string,
    indexState: SessionIndexReadState,
): Promise<readonly CliSessionCatalogDiagnostic[]> {
    if (indexState.store === undefined) {
        return [];
    }
    try {
        const primary = (await indexState.store.getDiagnostics(sessionId)).map(sanitizeIndexDiagnostic);
        if (primary.length > 0 || indexState.diagnosticStore === undefined) {
            return primary;
        }
        return (await indexState.diagnosticStore.getDiagnostics(sessionId)).map(sanitizeIndexDiagnostic);
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

export function indexStateLabel(
    hasFreshIndex: boolean,
    indexState: SessionIndexReadState,
): CliSessionCatalogIndexState {
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

async function localSessionDbExists(dataDir: string): Promise<boolean> {
    try {
        await stat(localSessionDbPath(dataDir));
        return true;
    } catch (error: unknown) {
        if (isMissingFileError(error)) {
            return false;
        }
        throw error;
    }
}

function sessionIndexPath(dataDir: string): string {
    return join(dataDir, 'session-index.json');
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error && Reflect.get(error, 'code') === 'ENOENT';
}
