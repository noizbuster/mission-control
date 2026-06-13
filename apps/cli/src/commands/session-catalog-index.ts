import {
    createFileSessionIndexStore,
    resolveMissionControlDataDir,
    type SessionIndexDiagnostic,
    type SessionIndexSessionRecord,
    type SessionIndexStore,
} from '@mission-control/core';
import type { CliSessionCatalogDiagnostic, CliSessionCatalogIndexState } from './session-catalog.js';
import { join } from 'node:path';

export type SessionIndexReadState = {
    readonly records: ReadonlyMap<string, SessionIndexSessionRecord>;
    readonly diagnostics: readonly CliSessionCatalogDiagnostic[];
    readonly store?: SessionIndexStore | undefined;
};

export async function readSessionIndexState(): Promise<SessionIndexReadState> {
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

export async function readIndexDiagnosticsForSession(
    sessionId: string,
    indexState: SessionIndexReadState,
): Promise<readonly CliSessionCatalogDiagnostic[]> {
    if (indexState.store === undefined) {
        return [];
    }
    try {
        return (await indexState.store.getDiagnostics(sessionId)).map(sanitizeIndexDiagnostic);
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

function sessionIndexPath(): string {
    return join(resolveMissionControlDataDir(), 'session-index.json');
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error && Reflect.get(error, 'code') === 'ENOENT';
}
