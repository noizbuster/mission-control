import { type Mission, MissionSchema, type Run, RunSchema } from '@mission-control/protocol';
import { z } from 'zod';
import { runLocalLibsqlWrite } from '../../db/local-libsql-db.js';
import { openRuntimeLocalDb } from '../local-runtime-db.js';

const missionRowSchema = z.object({ payload_json: z.string() });
const runRowSchema = z.object({ passthrough_json: z.string() });

export async function writeMissionToDb(root: string, mission: Mission): Promise<void> {
    const validated = MissionSchema.parse(mission);
    const runtime = await openRuntimeLocalDb(root);
    try {
        await runLocalLibsqlWrite(runtime, (client) =>
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
        );
    } finally {
        runtime.close();
    }
}

export async function readMissionFromDb(root: string, missionId: string): Promise<Mission | undefined> {
    const runtime = await openRuntimeLocalDb(root);
    try {
        const result = await runtime.client.execute({
            sql: 'SELECT payload_json FROM missions WHERE mission_id = ?',
            args: [missionId],
        });
        const row = result.rows[0];
        if (row === undefined) {
            return undefined;
        }
        return MissionSchema.parse(JSON.parse(missionRowSchema.parse(row).payload_json));
    } finally {
        runtime.close();
    }
}

export async function listMissionsFromDb(root: string): Promise<readonly Mission[]> {
    const runtime = await openRuntimeLocalDb(root);
    try {
        const result = await runtime.client.execute(
            'SELECT payload_json FROM missions ORDER BY updated_at, mission_id',
        );
        return result.rows.map((row) => MissionSchema.parse(JSON.parse(missionRowSchema.parse(row).payload_json)));
    } finally {
        runtime.close();
    }
}

export async function writeRunToDb(root: string, run: Run): Promise<void> {
    const validated = RunSchema.parse(run);
    const runtime = await openRuntimeLocalDb(root);
    const timestamp = new Date().toISOString();
    try {
        await runLocalLibsqlWrite(runtime, (client) =>
            client.execute({
                sql:
                    'INSERT INTO mission_runs (run_id, mission_id, parent_run_id, session_id, child_agent_kind, ' +
                    'child_agent_id, child_session_ids_json, retry_state_json, status, prompt, created_at, updated_at, ' +
                    'started_at, ended_at, completed_at, failed_at, cancelled_at, passthrough_json) ' +
                    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
                    'ON CONFLICT(run_id) DO UPDATE SET mission_id = excluded.mission_id, parent_run_id = excluded.parent_run_id, ' +
                    'session_id = excluded.session_id, child_agent_kind = excluded.child_agent_kind, child_agent_id = excluded.child_agent_id, ' +
                    'child_session_ids_json = excluded.child_session_ids_json, retry_state_json = excluded.retry_state_json, ' +
                    'status = excluded.status, prompt = excluded.prompt, updated_at = excluded.updated_at, started_at = excluded.started_at, ' +
                    'ended_at = excluded.ended_at, completed_at = excluded.completed_at, failed_at = excluded.failed_at, ' +
                    'cancelled_at = excluded.cancelled_at, passthrough_json = excluded.passthrough_json',
                args: [
                    validated.id,
                    validated.missionId,
                    validated.parentRunId ?? null,
                    validated.sessionId ?? null,
                    validated.childKind ?? null,
                    validated.childAgentId ?? null,
                    JSON.stringify(validated.childSessionIds ?? []),
                    JSON.stringify(validated.taskRetryState ?? {}),
                    validated.status,
                    validated.prompt ?? null,
                    validated.startedAt ?? timestamp,
                    timestamp,
                    validated.startedAt ?? null,
                    validated.endedAt ?? null,
                    validated.status === 'completed' ? (validated.endedAt ?? timestamp) : null,
                    validated.status === 'failed' ? (validated.endedAt ?? timestamp) : null,
                    validated.status === 'cancelled' ? (validated.endedAt ?? timestamp) : null,
                    JSON.stringify(validated),
                ],
            }),
        );
    } finally {
        runtime.close();
    }
}

export async function readRunFromDb(root: string, runId: string): Promise<Run | undefined> {
    const runtime = await openRuntimeLocalDb(root);
    try {
        const result = await runtime.client.execute({
            sql: 'SELECT passthrough_json FROM mission_runs WHERE run_id = ?',
            args: [runId],
        });
        const row = result.rows[0];
        if (row === undefined) {
            return undefined;
        }
        return RunSchema.parse(JSON.parse(runRowSchema.parse(row).passthrough_json));
    } finally {
        runtime.close();
    }
}

export async function listRunsFromDb(
    root: string,
    filter: { readonly missionId?: string; readonly parentId?: string } = {},
): Promise<readonly Run[]> {
    const runtime = await openRuntimeLocalDb(root);
    try {
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
    } finally {
        runtime.close();
    }
}
