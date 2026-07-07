import {
    normalizeWorkspaceRoot,
    ProjectTrustStore,
    type ReplayDiagnostic,
    readLocalSessionReplay,
} from '@mission-control/core';
import type { AgentSnapshot } from '@mission-control/protocol';
import {
    readIndexDiagnosticsForSession,
    readSessionIndexState,
    type SessionIndexReadState,
} from './session-catalog-index.js';
import type { CliSessionCatalogEntry } from './session-catalog-types.js';
import { parseCliSessionId } from './session-id.js';
import { resolve } from 'node:path';

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
          readonly workspaceTrust?: 'trusted' | 'denied' | 'unknown' | undefined;
          readonly name?: string | undefined;
          readonly activeLeafId?: string | undefined;
          readonly parentSessionId?: string | undefined;
          readonly diagnostics: readonly ReplayDiagnostic[];
      };

export async function normalizeWorkspaceRootWithFallback(workspaceRoot: string): Promise<string> {
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
    const projection = await readSessionProjection(parsedSessionId);
    const indexDiagnostics = await readIndexDiagnosticsForSession(parsedSessionId, resolvedIndexState);
    if (projection.kind === 'missing') {
        if (indexRecord !== undefined) {
            return {
                sessionId: parsedSessionId,
                status: indexRecord.status,
                ...(indexRecord.awaiting !== undefined ? { awaiting: indexRecord.awaiting } : {}),
                eventCount: indexRecord.eventCount,
                messageCount: 0,
                createdAt: indexRecord.startedAt,
                updatedAt: indexRecord.updatedAt,
                cwd: undefined,
                trustedRoot: undefined,
                name: undefined,
                activeLeafId: undefined,
                parentSessionId: undefined,
                trustStatus: 'unknown',
                diagnostics: [...resolvedIndexState.diagnostics, ...indexDiagnostics],
            };
        }
        return {
            sessionId: parsedSessionId,
            status: 'missing',
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
            diagnostics: [...resolvedIndexState.diagnostics, ...indexDiagnostics],
        };
    }
    const hasDiagnostics = projection.diagnostics.length > 0;
    const canUseDbSummary = indexRecord !== undefined && !hasDiagnostics;
    return {
        sessionId: parsedSessionId,
        status: hasDiagnostics ? 'corrupt' : canUseDbSummary ? indexRecord.status : projection.snapshot.status,
        ...(canUseDbSummary && indexRecord.awaiting !== undefined
            ? { awaiting: indexRecord.awaiting }
            : projection.snapshot.awaiting !== undefined
              ? { awaiting: projection.snapshot.awaiting }
              : {}),
        eventCount: projection.eventCount,
        messageCount: projection.messageCount,
        createdAt: projection.createdAt,
        updatedAt: indexRecord?.updatedAt ?? projection.updatedAt,
        cwd: projection.cwd,
        trustedRoot: projection.trustedRoot,
        name: projection.name,
        activeLeafId: projection.activeLeafId,
        parentSessionId: projection.parentSessionId,
        trustStatus: await readTrustStatus(projection.workspaceTrust, projection.trustedRoot ?? projection.cwd),
        diagnostics: [...projection.diagnostics, ...resolvedIndexState.diagnostics, ...indexDiagnostics],
    };
}

async function readSessionProjection(sessionId: string): Promise<SessionProjectionResult> {
    const replay = await readLocalSessionReplay({ sessionId });
    if (replay.kind === 'missing') {
        return { kind: 'missing' };
    }
    const projection = replay.replay.projection;
    const lastEvent = projection.events.at(-1);
    return {
        kind: 'projection',
        snapshot: projection.snapshot,
        eventCount: projection.events.length,
        messageCount: projection.events.filter((event) => event.message !== undefined).length,
        createdAt: projection.envelopes.at(0)?.createdAt ?? projection.snapshot.startedAt,
        updatedAt: lastEvent?.timestamp,
        cwd: projection.sessionTree.cwd,
        trustedRoot: projection.sessionTree.trustedRoot,
        workspaceTrust: projection.sessionTree.workspaceTrust,
        name: projection.sessionTree.sessionName,
        activeLeafId: projection.sessionTree.activeLeafId,
        parentSessionId: projection.sessionTree.parentSessionId,
        diagnostics: replay.replay.diagnostics,
    };
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

function requireValidSessionId(sessionId: string): string {
    const parsed = parseCliSessionId(sessionId);
    if (parsed === undefined) {
        throw new TypeError(`invalid session id: ${sessionId}`);
    }
    return parsed;
}
