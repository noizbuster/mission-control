import type { Client } from '@libsql/client';
import { ensurePublicSessionRow } from '../memory/session-awaiting-sql';
import { ensureSessionWithIdentity } from '../memory/session-identity-sql';
import { runtimeStatusToDb } from './agent-job-sql-mirror-rows';
import type { BackgroundJobHandle } from './async-job-manager';
import type { AgentRef } from './runtime-registry';

export type ChildSessionTerminalStatus = 'completed' | 'failed' | 'cancelled';

export async function upsertRuntimeAgentRow(input: { readonly client: Client; readonly ref: AgentRef }): Promise<void> {
    await ensurePublicSessionRow({
        client: input.client,
        sessionId: input.ref.sessionId,
        now: input.ref.lastActivity,
    });
    await ensureSessionWithIdentity({
        client: input.client,
        sessionId: input.ref.sessionId,
        now: input.ref.lastActivity,
        agentName: input.ref.displayName,
        ...(input.ref.title !== undefined ? { title: input.ref.title } : {}),
        ...(input.ref.category !== undefined ? { category: input.ref.category } : {}),
        ...(input.ref.parentId !== undefined ? { parentSessionId: input.ref.parentId } : {}),
    });
    if (input.ref.parentId !== undefined && input.ref.status === 'running') {
        await markChildSessionRunning({
            client: input.client,
            sessionId: input.ref.sessionId,
            parentSessionId: input.ref.parentId,
            now: input.ref.lastActivity,
        });
    }
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
                ...(input.ref.taskDepth !== undefined ? { taskDepth: input.ref.taskDepth } : {}),
                ...(input.ref.category !== undefined ? { category: input.ref.category } : {}),
                ...(input.ref.title !== undefined ? { title: input.ref.title } : {}),
            }),
        ],
    });
}

export async function upsertJobRow(input: {
    readonly client: Client;
    readonly handle: BackgroundJobHandle;
}): Promise<void> {
    const terminalAt = input.handle.completedAt ?? null;
    const now = input.handle.completedAt ?? input.handle.startedAt;
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
        if (input.handle.status === 'queued' || input.handle.status === 'running') {
            await markChildSessionRunning({
                client: input.client,
                sessionId: input.handle.sessionId,
                parentSessionId: input.handle.parentSessionId,
                now: input.handle.startedAt,
            });
        } else {
            await markChildSessionSettled({
                client: input.client,
                sessionId: input.handle.sessionId,
                parentSessionId: input.handle.parentSessionId,
                status: input.handle.status,
                now,
            });
        }
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
        await upsertSubagentRelation({
            client: input.client,
            parentSessionId: input.handle.parentSessionId,
            childSessionId: input.handle.sessionId,
            now: input.handle.startedAt,
            metadata: { agentId: input.handle.agentId ?? null, jobId: input.handle.jobId },
        });
    }
}

export async function markChildSessionRunning(input: {
    readonly client: Client;
    readonly sessionId: string;
    readonly parentSessionId: string;
    readonly now: string;
}): Promise<void> {
    await ensurePublicSessionRow({
        client: input.client,
        sessionId: input.sessionId,
        now: input.now,
    });
    await input.client.execute({
        sql:
            'UPDATE sessions SET parent_session_id = ?, status = ?, updated_at = ?, last_activity_at = ? ' +
            'WHERE session_id = ? AND status NOT IN (?, ?)',
        args: [input.parentSessionId, 'running', input.now, input.now, input.sessionId, 'stopped', 'failed'],
    });
}

export async function markChildSessionSettled(input: {
    readonly client: Client;
    readonly sessionId: string;
    readonly parentSessionId: string;
    readonly status: ChildSessionTerminalStatus;
    readonly now: string;
}): Promise<void> {
    await ensurePublicSessionRow({
        client: input.client,
        sessionId: input.sessionId,
        now: input.now,
    });
    const sessionStatus = input.status === 'failed' ? 'failed' : 'idle';
    await input.client.execute({
        sql:
            'UPDATE sessions SET parent_session_id = COALESCE(parent_session_id, ?), status = ?, ' +
            'failed_at = CASE WHEN ? = ? THEN COALESCE(failed_at, ?) ELSE failed_at END, ' +
            'updated_at = ?, last_activity_at = ? WHERE session_id = ? AND status NOT IN (?)',
        args: [
            input.parentSessionId,
            sessionStatus,
            sessionStatus,
            'failed',
            input.now,
            input.now,
            input.now,
            input.sessionId,
            'stopped',
        ],
    });
}

export async function upsertSubagentRelation(input: {
    readonly client: Client;
    readonly parentSessionId: string;
    readonly childSessionId: string;
    readonly now: string;
    readonly metadata: Readonly<Record<string, string | null>>;
}): Promise<void> {
    await input.client.execute({
        sql:
            'INSERT INTO session_relations ' +
            '(relation_id, parent_session_id, child_session_id, kind, created_at, metadata_json) ' +
            'VALUES (?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(parent_session_id, child_session_id, kind) DO UPDATE SET created_at = excluded.created_at, ' +
            'metadata_json = excluded.metadata_json',
        args: [
            relationId(input.parentSessionId, input.childSessionId, 'subagent'),
            input.parentSessionId,
            input.childSessionId,
            'subagent',
            input.now,
            JSON.stringify(input.metadata),
        ],
    });
}

function relationId(parentSessionId: string, childSessionId: string, kind: string): string {
    return `${parentSessionId}:${childSessionId}:${kind}`;
}
