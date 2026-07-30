import { and, count, eq, gt, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import { drizzleFromClient, type MissionControlDrizzleDb } from '../db/drizzle-client';
import { runLocalLibsqlWrite } from '../db/local-libsql-db';
import { runLocalLibsqlClientTransaction } from '../db/local-libsql-transaction';
import {
    approvals,
    asyncJobs,
    contextEpochs,
    desktopApprovalEffects,
    desktopToolProposals,
    missionRuns,
    providerFailures,
    runtimeAgents,
    sessionAwaits,
    sessionControlLeases,
    sessionEventSequences,
    sessionEvents,
    sessionInputs,
    sessionMessages,
    sessionParts,
    sessionProjectionDiagnostics,
    sessionProjectionRuns,
    sessionRelations,
    sessions,
    toolCalls,
} from '../db/schema';
import type { ObservabilityRedactor } from '../providers/observability-redactor';
import { openCanonicalRuntimeDb } from '../runtime/local-runtime-db';
import { readCanonicalSessionTree } from '../runtime/session-stop-tree-resolver';
import type { SessionStoreIdentity } from '../runtime/session-store-identity';
import { computeCanonicalSessionTreeToken } from '../runtime/session-tree-token';
import { resolveMissionControlDataDir } from './data-dir';
import { createSqliteSessionProjectionStore, type SqliteSessionProjectionStore } from './sqlite-session-projection';

export type EnsuredLocalSessionDatabase = {
    readonly identity: SessionStoreIdentity;
    readonly runtime: Awaited<ReturnType<typeof openCanonicalRuntimeDb>>['runtime'];
};

export async function openLocalSessionProjectionStore(
    input: { readonly dataDir?: string; readonly now?: () => string } = {},
): Promise<SqliteSessionProjectionStore> {
    const dataDir = input.dataDir ?? resolveMissionControlDataDir();
    const opened = await openEnsuredLocalSessionDatabase({
        dataDir,
        ...(input.now !== undefined ? { now: input.now } : {}),
    });
    return createSqliteSessionProjectionStore(opened.runtime);
}

export async function deleteLocalSessionRows(input: {
    readonly dataDir?: string;
    readonly sessionIds: readonly string[];
    readonly now?: () => string;
}): Promise<void> {
    const dataDir = input.dataDir ?? resolveMissionControlDataDir();
    const { runtime } = await openEnsuredLocalSessionDatabase({
        dataDir,
        ...(input.now !== undefined ? { now: input.now } : {}),
    });
    try {
        for (const sessionId of input.sessionIds) {
            await runLocalLibsqlWrite(runtime, async (client) => {
                await deleteSessionRows(drizzleFromClient(client), sessionId);
            });
        }
    } finally {
        runtime.close();
    }
}

export type LocalSessionTreeDeleteRecord = {
    readonly sessionId: string;
    readonly eventCount: number;
};

export type LocalSessionTreeDeleteErrorCode =
    | 'session_not_found'
    | 'unstable_session_tree'
    | 'session_tree_changed'
    | 'session_live_locked';

export class LocalSessionTreeDeleteError extends Error {
    readonly code: LocalSessionTreeDeleteErrorCode;

    constructor(code: LocalSessionTreeDeleteErrorCode) {
        super(code);
        this.name = 'LocalSessionTreeDeleteError';
        this.code = code;
    }
}

const eventCountRowSchema = z.object({
    sessionId: z.string(),
    eventCount: z.number().int().nonnegative(),
});

export async function deleteLocalSessionTreeRows(input: {
    readonly dataDir?: string;
    readonly targetSessionId: string;
    readonly expectedTreeToken?: string;
    readonly nowWallMs?: number;
}): Promise<readonly LocalSessionTreeDeleteRecord[]> {
    const dataDir = input.dataDir ?? resolveMissionControlDataDir();
    const { identity, runtime } = await openEnsuredLocalSessionDatabase({ dataDir });
    try {
        return await runLocalLibsqlWrite(runtime, (client) =>
            runLocalLibsqlClientTransaction(client, async () => {
                const tree = await readCanonicalSessionTree(client, input.targetSessionId);
                if (!tree.ok) throw new LocalSessionTreeDeleteError(tree.errorCode);
                const target = tree.nodes.find(({ sessionId }) => sessionId === input.targetSessionId);
                if (target === undefined) throw new LocalSessionTreeDeleteError('session_not_found');
                const nodes = [{ ...target, depth: 0 }, ...tree.descendants];
                const token = computeCanonicalSessionTreeToken(nodes);
                if (input.expectedTreeToken !== undefined && input.expectedTreeToken !== token) {
                    throw new LocalSessionTreeDeleteError('session_tree_changed');
                }

                const sessionIds = nodes.map(({ sessionId }) => sessionId);
                const db = drizzleFromClient(client);
                const liveLease = await db
                    .select({ sessionId: sessionControlLeases.sessionId })
                    .from(sessionControlLeases)
                    .where(
                        and(
                            eq(sessionControlLeases.dbIdentity, identity.dbIdentity),
                            inArray(sessionControlLeases.sessionId, [...sessionIds]),
                            gt(sessionControlLeases.expiresWallMs, input.nowWallMs ?? Date.now()),
                        ),
                    )
                    .limit(1);
                if (liveLease[0] !== undefined) throw new LocalSessionTreeDeleteError('session_live_locked');

                const counts = await db
                    .select({
                        sessionId: sessionEvents.sessionId,
                        eventCount: count(),
                    })
                    .from(sessionEvents)
                    .where(inArray(sessionEvents.sessionId, [...sessionIds]))
                    .groupBy(sessionEvents.sessionId);
                const eventCounts = new Map(
                    counts.map((row) => {
                        const parsed = eventCountRowSchema.parse(row);
                        return [parsed.sessionId, parsed.eventCount] as const;
                    }),
                );
                for (const sessionId of sessionIds) {
                    await deleteSessionRows(db, sessionId);
                }
                return sessionIds.map((sessionId) => ({ sessionId, eventCount: eventCounts.get(sessionId) ?? 0 }));
            }),
        );
    } finally {
        runtime.close();
    }
}

async function deleteSessionRows(db: MissionControlDrizzleDb, sessionId: string): Promise<void> {
    await db.delete(sessionParts).where(eq(sessionParts.sessionId, sessionId));
    await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, sessionId));
    await db.delete(sessionEvents).where(eq(sessionEvents.sessionId, sessionId));
    await db.delete(sessionEventSequences).where(eq(sessionEventSequences.sessionId, sessionId));
    await db.delete(sessionProjectionRuns).where(eq(sessionProjectionRuns.sessionId, sessionId));
    await db.delete(sessionProjectionDiagnostics).where(eq(sessionProjectionDiagnostics.sessionId, sessionId));
    await db.delete(approvals).where(eq(approvals.sessionId, sessionId));
    await db.delete(toolCalls).where(eq(toolCalls.sessionId, sessionId));
    await db.delete(desktopToolProposals).where(eq(desktopToolProposals.sessionId, sessionId));
    await db.delete(desktopApprovalEffects).where(eq(desktopApprovalEffects.sessionId, sessionId));
    await db.delete(providerFailures).where(eq(providerFailures.sessionId, sessionId));
    await db.delete(sessionInputs).where(eq(sessionInputs.sessionId, sessionId));
    await db
        .delete(sessionAwaits)
        .where(or(eq(sessionAwaits.sessionId, sessionId), eq(sessionAwaits.childSessionId, sessionId)));
    await db.delete(contextEpochs).where(eq(contextEpochs.sessionId, sessionId));
    await db
        .delete(sessionRelations)
        .where(or(eq(sessionRelations.parentSessionId, sessionId), eq(sessionRelations.childSessionId, sessionId)));
    await db.update(missionRuns).set({ sessionId: null }).where(eq(missionRuns.sessionId, sessionId));
    await db.update(runtimeAgents).set({ sessionId: null }).where(eq(runtimeAgents.sessionId, sessionId));
    await db.update(asyncJobs).set({ parentSessionId: null }).where(eq(asyncJobs.parentSessionId, sessionId));
    await db.update(asyncJobs).set({ childSessionId: null }).where(eq(asyncJobs.childSessionId, sessionId));
    await db.delete(sessions).where(eq(sessions.sessionId, sessionId));
}

export async function ensureLocalSessionDatabase(input: {
    readonly dataDir: string;
    readonly now?: () => string;
    readonly observabilityRedactor?: ObservabilityRedactor;
}): Promise<SessionStoreIdentity> {
    const { identity, runtime } = await openEnsuredLocalSessionDatabase(input);
    runtime.close();
    return identity;
}

export async function openEnsuredLocalSessionDatabase(input: {
    readonly dataDir: string;
    readonly now?: () => string;
    readonly observabilityRedactor?: ObservabilityRedactor;
}): Promise<EnsuredLocalSessionDatabase> {
    void input.now;
    void input.observabilityRedactor;
    return openCanonicalRuntimeDb({ dataDir: input.dataDir });
}
