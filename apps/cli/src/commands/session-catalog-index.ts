import {
    createLocalSessionIndexStore,
    resolveMissionControlDataDir,
    type SessionIndexDiagnostic,
    type SessionIndexSessionRecord,
    type SessionIndexStore,
} from '@mission-control/core';
import type { CliSessionCatalogDiagnostic } from './session-catalog.js';

export type SessionIndexReadState = {
    readonly records: ReadonlyMap<string, SessionIndexSessionRecord>;
    readonly diagnostics: readonly CliSessionCatalogDiagnostic[];
    readonly store: SessionIndexStore;
};

export async function readSessionIndexState(): Promise<SessionIndexReadState> {
    return readStoreIndexState(await createLocalSessionIndexStore({ dataDir: resolveMissionControlDataDir() }));
}

async function readStoreIndexState(store: SessionIndexStore): Promise<SessionIndexReadState> {
    const sessions = await store.listSessions();
    return {
        records: new Map(sessions.map((session) => [session.sessionId, session])),
        diagnostics: [],
        store,
    };
}

export async function readIndexDiagnosticsForSession(
    sessionId: string,
    indexState: SessionIndexReadState,
): Promise<readonly CliSessionCatalogDiagnostic[]> {
    return (await indexState.store.getDiagnostics(sessionId)).map(sanitizeIndexDiagnostic);
}

function sanitizeIndexDiagnostic(diagnostic: SessionIndexDiagnostic): CliSessionCatalogDiagnostic {
    return {
        code: 'index_diagnostic',
        sessionId: diagnostic.sessionId,
        message: 'session index contains a diagnostic record',
        lineNumber: diagnostic.lineNumber,
    };
}
