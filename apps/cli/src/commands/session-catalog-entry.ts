import { normalizeWorkspaceRoot, type ObservabilityRedactor } from '@mission-control/core';
import {
    readProjectionDiagnosticsForSession,
    readSessionProjectionState,
    type SessionProjectionReadState,
} from './session-catalog-projection';
import type { CliSessionCatalogEntry } from './session-catalog-types';
import { parseCliSessionId } from './session-id';
import { resolve } from 'node:path';

export async function normalizeWorkspaceRootWithFallback(workspaceRoot: string): Promise<string> {
    try {
        return await normalizeWorkspaceRoot(workspaceRoot);
    } catch {
        return resolve(workspaceRoot);
    }
}

export async function readSessionCatalogEntry(
    sessionId: string,
    projectionState?: SessionProjectionReadState,
    observabilityRedactor?: ObservabilityRedactor,
): Promise<CliSessionCatalogEntry> {
    void observabilityRedactor;
    const parsedSessionId = requireValidSessionId(sessionId);
    if (projectionState !== undefined) {
        return readSessionCatalogEntryFromProjectionState(parsedSessionId, projectionState);
    }
    const openedProjectionState = await readSessionProjectionState();
    try {
        return await readSessionCatalogEntryFromProjectionState(parsedSessionId, openedProjectionState);
    } finally {
        openedProjectionState.store.close();
    }
}

async function readSessionCatalogEntryFromProjectionState(
    parsedSessionId: string,
    projectionState: SessionProjectionReadState,
): Promise<CliSessionCatalogEntry> {
    const projectionRecord = projectionState.records.get(parsedSessionId);
    const projectionDiagnostics = await readProjectionDiagnosticsForSession(parsedSessionId, projectionState);
    const sessionHasDiagnostics = projectionDiagnostics.length > 0;
    const diagnostics = [...projectionState.diagnostics, ...projectionDiagnostics];

    if (projectionRecord === undefined) {
        return {
            sessionId: parsedSessionId,
            status: sessionHasDiagnostics ? 'corrupt' : 'missing',
            eventCount: 0,
            messageCount: 0,
            createdAt: undefined,
            updatedAt: undefined,
            cwd: undefined,
            trustedRoot: undefined,
            name: undefined,
            activeLeafId: undefined,
            parentSessionId: undefined,
            trustStatus: 'unknown',
            diagnostics,
        };
    }

    return {
        sessionId: parsedSessionId,
        status: sessionHasDiagnostics ? 'corrupt' : projectionRecord.status,
        ...(projectionRecord.awaiting !== undefined ? { awaiting: projectionRecord.awaiting } : {}),
        eventCount: projectionRecord.eventCount,
        messageCount: projectionRecord.messageCount ?? 0,
        createdAt: projectionRecord.startedAt,
        updatedAt: projectionRecord.updatedAt,
        ...(projectionRecord.cwd !== undefined ? { cwd: projectionRecord.cwd } : { cwd: undefined }),
        ...(projectionRecord.trustedRoot !== undefined
            ? { trustedRoot: projectionRecord.trustedRoot }
            : { trustedRoot: undefined }),
        ...(projectionRecord.name !== undefined ? { name: projectionRecord.name } : { name: undefined }),
        ...(projectionRecord.activeLeafId !== undefined
            ? { activeLeafId: projectionRecord.activeLeafId }
            : { activeLeafId: undefined }),
        ...(projectionRecord.parentSessionId !== undefined
            ? { parentSessionId: projectionRecord.parentSessionId }
            : { parentSessionId: undefined }),
        trustStatus: projectionRecord.workspaceTrust ?? 'unknown',
        diagnostics,
    };
}

function requireValidSessionId(sessionId: string): string {
    const parsed = parseCliSessionId(sessionId);
    if (parsed === undefined) {
        throw new TypeError(`invalid session id: ${sessionId}`);
    }
    return parsed;
}
