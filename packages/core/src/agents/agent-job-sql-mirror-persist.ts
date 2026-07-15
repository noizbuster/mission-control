import type { Client } from '@libsql/client';
import { ensurePublicSessionRow } from '../memory/session-awaiting-sql';
import { runtimeStatusToDb } from './agent-job-sql-mirror-rows';
import type { BackgroundJobHandle } from './async-job-manager';
import type { AgentRef } from './runtime-registry';

export async function upsertRuntimeAgentRow(input: { readonly client: Client; readonly ref: AgentRef }): Promise<void> {
    await ensurePublicSessionRow({
        client: input.client,
        sessionId: input.ref.sessionId,
        now: input.ref.lastActivity,
    });
    await input.client.execute({
        sql:
            'INSERT INTO runtime_agents ' +
            '(agent_id, kind, session_id, parent_agent_id, status, activity, created_at, updated_at, metadata_json) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(agent_id) DO UPDATE SET kind = excluded.kind, session_id = excluded.session_id, ' +
            'parent_agent_id = excluded.parent_agent_id, status = excluded.status, activity = excluded.activity, ' +
            'updated_at = excluded.updated_at, metadata_json = excluded.metadata_json',
        args: [
            input.ref.id,
            input.ref.kind,
            input.ref.sessionId,
            input.ref.parentId ?? null,
            runtimeStatusToDb(input.ref.status),
            input.ref.activity ?? null,
            input.ref.createdAt,
            input.ref.lastActivity,
            JSON.stringify({
                displayName: input.ref.displayName,
                ...(input.ref.sessionFile !== undefined ? { sessionFile: input.ref.sessionFile } : {}),
                ...(input.ref.authorityFingerprint !== undefined
                    ? { authorityFingerprint: input.ref.authorityFingerprint }
                    : {}),
            }),
        ],
    });
}

export async function upsertJobRow(input: {
    readonly client: Client;
    readonly handle: BackgroundJobHandle;
}): Promise<void> {
    const terminalAt = input.handle.completedAt ?? null;
    await ensurePublicSessionRow({
        client: input.client,
        sessionId: input.handle.sessionId,
        now: input.handle.startedAt,
    });
    if (input.handle.parentSessionId !== undefined) {
        await ensurePublicSessionRow({
            client: input.client,
            sessionId: input.handle.parentSessionId,
            now: input.handle.startedAt,
        });
    }
    await input.client.execute({
        sql:
            'INSERT INTO async_jobs ' +
            '(job_id, parent_session_id, child_session_id, agent_id, status, queued_at, started_at, completed_at, failed_at, cancelled_at, cancellation_reason, result_json, error_json, metadata_json) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(job_id) DO UPDATE SET parent_session_id = excluded.parent_session_id, ' +
            'child_session_id = excluded.child_session_id, agent_id = excluded.agent_id, status = excluded.status, ' +
            'started_at = excluded.started_at, completed_at = excluded.completed_at, failed_at = excluded.failed_at, ' +
            'cancelled_at = excluded.cancelled_at, cancellation_reason = excluded.cancellation_reason, ' +
            'result_json = excluded.result_json, error_json = excluded.error_json, metadata_json = excluded.metadata_json',
        args: [
            input.handle.jobId,
            input.handle.parentSessionId ?? null,
            input.handle.sessionId,
            input.handle.agentId ?? null,
            input.handle.status,
            input.handle.startedAt,
            input.handle.status === 'queued' ? null : input.handle.startedAt,
            input.handle.status === 'completed' ? terminalAt : null,
            input.handle.status === 'failed' ? terminalAt : null,
            input.handle.status === 'cancelled' ? terminalAt : null,
            input.handle.cancellationReason ?? null,
            input.handle.result === undefined ? null : JSON.stringify(input.handle.result),
            input.handle.error === undefined ? null : JSON.stringify({ message: input.handle.error }),
            JSON.stringify({ blocking: input.handle.blocking }),
        ],
    });
    if (input.handle.parentSessionId !== undefined) {
        await input.client.execute({
            sql:
                'INSERT INTO session_relations ' +
                '(relation_id, parent_session_id, child_session_id, kind, created_at, metadata_json) ' +
                'VALUES (?, ?, ?, ?, ?, ?) ' +
                'ON CONFLICT(parent_session_id, child_session_id, kind) DO UPDATE SET created_at = excluded.created_at, ' +
                'metadata_json = excluded.metadata_json',
            args: [
                relationId(input.handle.parentSessionId, input.handle.sessionId, 'subagent'),
                input.handle.parentSessionId,
                input.handle.sessionId,
                'subagent',
                input.handle.startedAt,
                JSON.stringify({ agentId: input.handle.agentId ?? null, jobId: input.handle.jobId }),
            ],
        });
    }
}

function relationId(parentSessionId: string, childSessionId: string, kind: string): string {
    return `${parentSessionId}:${childSessionId}:${kind}`;
}
