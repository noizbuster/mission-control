import type { Client } from '@libsql/client';
import { type Mission, MissionSchema, type Run, RunSchema } from '@mission-control/protocol';
import { z } from 'zod';
import { type LocalLibsqlDb, runLocalLibsqlWrite } from '../../db/local-libsql-db';
import { runLocalLibsqlClientTransaction } from '../../db/local-libsql-transaction';
import { openMissionControlDb } from '../../db/mission-control-db';
import { refreshSessionAwaitingFromPendingWaits } from '../../memory/session-awaiting-sql';

const missionRowSchema = z.object({ payload_json: z.string() });
const runRowSchema = z.object({ passthrough_json: z.string() });

export async function writeMissionToDb(dataDir: string, mission: Mission): Promise<void> {
    const validated = MissionSchema.parse(mission);
    await withMissionRunRuntime(dataDir, (runtime) =>
        runLocalLibsqlWrite(runtime, (client) =>
            client.execute({
                sql:
                    'INSERT INTO missions (mission_id, status, workflow_name, created_at, updated_at, payload_json) ' +
                    'VALUES (?, ?, ?, ?, ?, ?) ' +
                    'ON CONFLICT(mission_id) DO UPDATE SET status = excluded.status, workflow_name = excluded.workflow_name, ' +
                    'updated_at = excluded.updated_at, payload_json = excluded.payload_json',
                args: [
                    validated.id,
                    validated.status,
                    validated.workflowName ?? null,
                    validated.createdAt,
                    validated.updatedAt,
                    JSON.stringify(validated),
                ],
            }),
        ),
    );
}

export async function readMissionFromDb(dataDir: string, missionId: string): Promise<Mission | undefined> {
    return withMissionRunRuntime(dataDir, async (runtime) => {
        const result = await runtime.client.execute({
            sql: 'SELECT payload_json FROM missions WHERE mission_id = ?',
            args: [missionId],
        });
        const row = result.rows[0];
        if (row === undefined) {
            return undefined;
        }
        return MissionSchema.parse(JSON.parse(missionRowSchema.parse(row).payload_json));
    });
}

export async function listMissionsFromDb(dataDir: string): Promise<readonly Mission[]> {
    return withMissionRunRuntime(dataDir, async (runtime) => {
        const result = await runtime.client.execute(
            'SELECT payload_json FROM missions ORDER BY updated_at, mission_id',
        );
        return result.rows.map((row) => MissionSchema.parse(JSON.parse(missionRowSchema.parse(row).payload_json)));
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
        const conditions: string[] = [];
        const args: string[] = [];
        if (filter.missionId !== undefined) {
            conditions.push('mission_id = ?');
            args.push(filter.missionId);
        }
        if (filter.parentId !== undefined) {
            conditions.push('parent_run_id = ?');
            args.push(filter.parentId);
        }
        const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
        const result = await runtime.client.execute({
            sql: `SELECT passthrough_json FROM mission_runs${where} ORDER BY created_at, run_id`,
            args,
        });
        return result.rows.map((row) => RunSchema.parse(JSON.parse(runRowSchema.parse(row).passthrough_json)));
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
    const result = await client.execute({
        sql: 'SELECT passthrough_json FROM mission_runs WHERE run_id = ?',
        args: [runId],
    });
    const row = result.rows[0];
    return row === undefined ? undefined : RunSchema.parse(JSON.parse(runRowSchema.parse(row).passthrough_json));
}

async function writeRunRow(
    client: Client,
    run: Run,
    timestamp: string,
    conflict: 'replace' | 'ignore' = 'replace',
): Promise<boolean> {
    const conflictClause =
        conflict === 'ignore'
            ? 'ON CONFLICT(run_id) DO NOTHING'
            : 'ON CONFLICT(run_id) DO UPDATE SET mission_id = excluded.mission_id, parent_run_id = excluded.parent_run_id, ' +
              'session_id = excluded.session_id, child_agent_kind = excluded.child_agent_kind, child_agent_id = excluded.child_agent_id, ' +
              'child_session_ids_json = excluded.child_session_ids_json, retry_state_json = excluded.retry_state_json, ' +
              'status = excluded.status, prompt = excluded.prompt, updated_at = excluded.updated_at, started_at = excluded.started_at, ' +
              'ended_at = excluded.ended_at, completed_at = excluded.completed_at, failed_at = excluded.failed_at, ' +
              'cancelled_at = excluded.cancelled_at, passthrough_json = excluded.passthrough_json';
    const result = await client.execute({
        sql:
            'INSERT INTO mission_runs (run_id, mission_id, parent_run_id, session_id, child_agent_kind, ' +
            'child_agent_id, child_session_ids_json, retry_state_json, status, prompt, created_at, updated_at, ' +
            'started_at, ended_at, completed_at, failed_at, cancelled_at, passthrough_json) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
            conflictClause,
        args: [
            run.id,
            run.missionId,
            run.parentRunId ?? null,
            run.sessionId ?? null,
            run.childKind ?? null,
            run.childAgentId ?? null,
            JSON.stringify(run.childSessionIds ?? []),
            JSON.stringify(run.taskRetryState ?? {}),
            run.status,
            run.prompt ?? null,
            run.startedAt ?? timestamp,
            timestamp,
            run.startedAt ?? null,
            run.endedAt ?? null,
            run.status === 'completed' ? (run.endedAt ?? timestamp) : null,
            run.status === 'failed' ? (run.endedAt ?? timestamp) : null,
            run.status === 'cancelled' ? (run.endedAt ?? timestamp) : null,
            JSON.stringify(run),
        ],
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
