import type { Client } from '@libsql/client';
import { type Mission, MissionSchema, type Run, RunSchema } from '@mission-control/protocol';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { drizzleFromClient } from '../../db/drizzle-client';
import { type LocalLibsqlDb, runLocalLibsqlWrite } from '../../db/local-libsql-db';
import { runLocalLibsqlClientTransaction } from '../../db/local-libsql-transaction';
import { openMissionControlDb } from '../../db/mission-control-db';
import { missionRuns, missions } from '../../db/schema';
import { refreshSessionAwaitingFromPendingWaits } from '../../memory/session-awaiting-sql';

const missionRowSchema = z.object({ payloadJson: z.string() });
const runRowSchema = z.object({ passthroughJson: z.string() });

export async function writeMissionToDb(dataDir: string, mission: Mission): Promise<void> {
    const validated = MissionSchema.parse(mission);
    await withMissionRunRuntime(dataDir, (runtime) =>
        runLocalLibsqlWrite(runtime, async (client) => {
            const db = drizzleFromClient(client);
            await db
                .insert(missions)
                .values({
                    missionId: validated.id,
                    status: validated.status,
                    workflowName: validated.workflowName ?? null,
                    createdAt: validated.createdAt,
                    updatedAt: validated.updatedAt,
                    payloadJson: JSON.stringify(validated),
                })
                .onConflictDoUpdate({
                    target: missions.missionId,
                    set: {
                        status: validated.status,
                        workflowName: validated.workflowName ?? null,
                        updatedAt: validated.updatedAt,
                        payloadJson: JSON.stringify(validated),
                    },
                });
        }),
    );
}

export async function readMissionFromDb(dataDir: string, missionId: string): Promise<Mission | undefined> {
    return withMissionRunRuntime(dataDir, async (runtime) => {
        const db = drizzleFromClient(runtime.client);
        const rows = await db
            .select({ payloadJson: missions.payloadJson })
            .from(missions)
            .where(eq(missions.missionId, missionId));
        const row = rows[0];
        if (row === undefined) {
            return undefined;
        }
        return MissionSchema.parse(JSON.parse(missionRowSchema.parse(row).payloadJson));
    });
}

export async function listMissionsFromDb(dataDir: string): Promise<readonly Mission[]> {
    return withMissionRunRuntime(dataDir, async (runtime) => {
        const db = drizzleFromClient(runtime.client);
        const rows = await db
            .select({ payloadJson: missions.payloadJson })
            .from(missions)
            .orderBy(asc(missions.updatedAt), asc(missions.missionId));
        return rows.map((row) => MissionSchema.parse(JSON.parse(missionRowSchema.parse(row).payloadJson)));
    });
}

export async function writeRunToDb(
    dataDir: string,
    run: Run,
    options: { readonly conflict?: 'replace' | 'ignore' } = {},
): Promise<boolean> {
    const validated = RunSchema.parse(run);
    const timestamp = new Date().toISOString();
    return withMissionRunRuntime(dataDir, (runtime) =>
        runLocalLibsqlWrite(runtime, async (client) =>
            runLocalLibsqlClientTransaction(client, async () => {
                const written = await writeRunRow(client, validated, timestamp, options.conflict ?? 'replace');
                if (written) await refreshRunSessions(client, [validated.sessionId], timestamp);
                return written;
            }),
        ),
    );
}

export async function mutateRunInDb(
    dataDir: string,
    runId: string,
    mutate: (run: Run) => Run,
): Promise<Run | undefined> {
    return withMissionRunRuntime(dataDir, (runtime) =>
        runLocalLibsqlWrite(runtime, async (client) =>
            runLocalLibsqlClientTransaction(client, async () => {
                const timestamp = new Date().toISOString();
                return mutateRunWithClient(client, runId, mutate, timestamp);
            }),
        ),
    );
}
export async function mutateRunWithClient(
    client: Client,
    runId: string,
    mutate: (run: Run) => Run,
    timestamp: string,
): Promise<Run | undefined> {
    const existing = await selectRun(client, runId);
    if (existing === undefined) return undefined;
    const candidate = mutate(existing);
    if (candidate === existing) return existing;
    const updated = RunSchema.parse(candidate);
    await writeRunRow(client, updated, timestamp);
    await refreshRunSessions(client, [existing.sessionId, updated.sessionId], timestamp);
    return updated;
}

export async function readRunFromDb(dataDir: string, runId: string): Promise<Run | undefined> {
    return withMissionRunRuntime(dataDir, (runtime) => selectRun(runtime.client, runId));
}

export async function listRunsFromDb(
    dataDir: string,
    filter: { readonly missionId?: string; readonly parentId?: string } = {},
): Promise<readonly Run[]> {
    return withMissionRunRuntime(dataDir, async (runtime) => {
        const db = drizzleFromClient(runtime.client);
        const conditions = [];
        if (filter.missionId !== undefined) {
            conditions.push(eq(missionRuns.missionId, filter.missionId));
        }
        if (filter.parentId !== undefined) {
            conditions.push(eq(missionRuns.parentRunId, filter.parentId));
        }
        const query = db.select({ passthroughJson: missionRuns.passthroughJson }).from(missionRuns);
        const filtered = conditions.length === 0 ? query : query.where(and(...conditions));
        const rows = await filtered.orderBy(asc(missionRuns.createdAt), asc(missionRuns.runId));
        return rows.map((row) => RunSchema.parse(JSON.parse(runRowSchema.parse(row).passthroughJson)));
    });
}

async function openMissionRunRuntime(dataDir: string): Promise<LocalLibsqlDb> {
    return openMissionControlDb({ dataDir });
}

/**
 * Open the mission-run DB, run `fn`, and always close. Replaces the 7 inline
 * `open → try → finally close` blocks in this module.
 */
async function withMissionRunRuntime<T>(dataDir: string, fn: (runtime: LocalLibsqlDb) => Promise<T>): Promise<T> {
    const runtime = await openMissionRunRuntime(dataDir);
    try {
        return await fn(runtime);
    } finally {
        runtime.close();
    }
}

async function selectRun(client: Client, runId: string): Promise<Run | undefined> {
    const db = drizzleFromClient(client);
    const rows = await db
        .select({ passthroughJson: missionRuns.passthroughJson })
        .from(missionRuns)
        .where(eq(missionRuns.runId, runId));
    const row = rows[0];
    return row === undefined ? undefined : RunSchema.parse(JSON.parse(runRowSchema.parse(row).passthroughJson));
}

async function writeRunRow(
    client: Client,
    run: Run,
    timestamp: string,
    conflict: 'replace' | 'ignore' = 'replace',
): Promise<boolean> {
    const db = drizzleFromClient(client);
    const values = {
        runId: run.id,
        missionId: run.missionId,
        parentRunId: run.parentRunId ?? null,
        sessionId: run.sessionId ?? null,
        childAgentKind: run.childKind ?? null,
        childAgentId: run.childAgentId ?? null,
        childSessionIdsJson: JSON.stringify(run.childSessionIds ?? []),
        retryStateJson: JSON.stringify(run.taskRetryState ?? {}),
        status: run.status,
        prompt: run.prompt ?? null,
        createdAt: run.startedAt ?? timestamp,
        updatedAt: timestamp,
        startedAt: run.startedAt ?? null,
        endedAt: run.endedAt ?? null,
        completedAt: run.status === 'completed' ? (run.endedAt ?? timestamp) : null,
        failedAt: run.status === 'failed' ? (run.endedAt ?? timestamp) : null,
        cancelledAt: run.status === 'cancelled' ? (run.endedAt ?? timestamp) : null,
        passthroughJson: JSON.stringify(run),
    };
    if (conflict === 'ignore') {
        const result = await db.insert(missionRuns).values(values).onConflictDoNothing();
        return result.rowsAffected > 0;
    }
    const result = await db
        .insert(missionRuns)
        .values(values)
        .onConflictDoUpdate({
            target: missionRuns.runId,
            set: {
                missionId: values.missionId,
                parentRunId: values.parentRunId,
                sessionId: values.sessionId,
                childAgentKind: values.childAgentKind,
                childAgentId: values.childAgentId,
                childSessionIdsJson: values.childSessionIdsJson,
                retryStateJson: values.retryStateJson,
                status: values.status,
                prompt: values.prompt,
                updatedAt: values.updatedAt,
                startedAt: values.startedAt,
                endedAt: values.endedAt,
                completedAt: values.completedAt,
                failedAt: values.failedAt,
                cancelledAt: values.cancelledAt,
                passthroughJson: values.passthroughJson,
            },
        });
    return result.rowsAffected > 0;
}

async function refreshRunSessions(
    client: Client,
    sessionIds: readonly (string | undefined)[],
    now: string,
): Promise<void> {
    for (const sessionId of new Set(sessionIds.filter((value): value is string => value !== undefined))) {
        await refreshSessionAwaitingFromPendingWaits({ client, sessionId, now });
    }
}
