import type { Client } from '@libsql/client';
import type { Run } from '@mission-control/protocol';

export async function importMissionRunRow(input: {
    readonly client: Client;
    readonly run: Run;
    readonly importedAt: string;
}): Promise<void> {
    const timestamp = input.importedAt;
    await input.client.execute({
        sql: `
            INSERT INTO mission_runs
                (run_id, mission_id, parent_run_id, session_id, child_agent_kind, child_agent_id,
                 child_session_ids_json, retry_state_json, status, prompt, created_at, updated_at, started_at,
                 ended_at, completed_at, failed_at, cancelled_at, passthrough_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
                mission_id = excluded.mission_id,
                parent_run_id = excluded.parent_run_id,
                session_id = excluded.session_id,
                child_agent_kind = excluded.child_agent_kind,
                child_agent_id = excluded.child_agent_id,
                child_session_ids_json = excluded.child_session_ids_json,
                retry_state_json = excluded.retry_state_json,
                status = excluded.status,
                prompt = excluded.prompt,
                updated_at = excluded.updated_at,
                started_at = excluded.started_at,
                ended_at = excluded.ended_at,
                completed_at = excluded.completed_at,
                failed_at = excluded.failed_at,
                cancelled_at = excluded.cancelled_at,
                passthrough_json = excluded.passthrough_json
        `,
        args: [
            input.run.id,
            input.run.missionId,
            input.run.parentRunId ?? null,
            input.run.sessionId ?? null,
            input.run.childKind ?? null,
            input.run.childAgentId ?? null,
            input.run.childSessionIds === undefined ? null : JSON.stringify(input.run.childSessionIds),
            input.run.taskRetryState === undefined ? null : JSON.stringify(input.run.taskRetryState),
            input.run.status,
            input.run.prompt ?? null,
            input.run.startedAt ?? input.run.endedAt ?? timestamp,
            timestamp,
            input.run.startedAt ?? null,
            input.run.endedAt ?? null,
            input.run.status === 'completed' ? (input.run.endedAt ?? null) : null,
            input.run.status === 'failed' ? (input.run.endedAt ?? null) : null,
            input.run.status === 'cancelled' ? (input.run.endedAt ?? null) : null,
            JSON.stringify(input.run),
        ],
    });
}
