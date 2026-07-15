import type { Client } from '@libsql/client';
import type { Run } from '@mission-control/protocol';
import type { ObservabilityRedactor } from '../providers/observability-redactor.js';
import { sanitizeRunForPersistence } from '../runtime/mission-run/run-persistence-sanitization.js';
import { runWithoutSessionOwnerAuthority } from '../runtime/mission-run/run-session-owner-authority.js';

export async function importMissionRunRow(input: {
    readonly client: Client;
    readonly run: Run;
    readonly importedAt: string;
    readonly observabilityRedactor?: ObservabilityRedactor;
}): Promise<boolean> {
    const timestamp = input.importedAt;
    const run = sanitizeRunForPersistence(runWithoutSessionOwnerAuthority(input.run), input.observabilityRedactor);
    const result = await input.client.execute({
        sql: `
            INSERT INTO mission_runs
                (run_id, mission_id, parent_run_id, session_id, child_agent_kind, child_agent_id,
                 child_session_ids_json, retry_state_json, status, prompt, created_at, updated_at, started_at,
                 ended_at, completed_at, failed_at, cancelled_at, passthrough_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO NOTHING
        `,
        args: [
            run.id,
            run.missionId,
            run.parentRunId ?? null,
            run.sessionId ?? null,
            run.childKind ?? null,
            run.childAgentId ?? null,
            run.childSessionIds === undefined ? null : JSON.stringify(run.childSessionIds),
            run.taskRetryState === undefined ? null : JSON.stringify(run.taskRetryState),
            run.status,
            run.prompt ?? null,
            run.startedAt ?? run.endedAt ?? timestamp,
            timestamp,
            run.startedAt ?? null,
            run.endedAt ?? null,
            run.status === 'completed' ? (run.endedAt ?? null) : null,
            run.status === 'failed' ? (run.endedAt ?? null) : null,
            run.status === 'cancelled' ? (run.endedAt ?? null) : null,
            JSON.stringify(run),
        ],
    });
    return result.rowsAffected > 0;
}
