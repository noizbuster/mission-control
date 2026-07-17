import type { Client } from '@libsql/client';
import {
    ensurePublicSessionRow,
    persistSessionAwaiting,
    refreshSessionAwaitingFromPendingWaits,
} from '../memory/session-awaiting-sql';
import { resolvedSubagentJob } from './agent-job-sql-mirror-handles';
import { upsertJobRow } from './agent-job-sql-mirror-persist';
import type { ResolveSubagentWaitInput, StartSubagentWaitInput } from './agent-job-sql-mirror-types';
import type { BackgroundJobHandle } from './async-job-manager';

export async function recordJobWithLifecycle(client: Client, handle: BackgroundJobHandle): Promise<void> {
    await upsertJobRow({ client, handle });
    if (handle.parentSessionId !== undefined) {
        await refreshSessionAwaitingFromPendingWaits({
            client,
            sessionId: handle.parentSessionId,
            now: handle.completedAt ?? new Date().toISOString(),
        });
    }
}

export async function startSubagentWaitWithJob(
    client: Client,
    input: StartSubagentWaitInput,
    now: string,
): Promise<void> {
    await ensurePublicSessionRow({ client, sessionId: input.parentSessionId, now });
    await ensurePublicSessionRow({ client, sessionId: input.childSessionId, now });
    await client.execute({
        sql: 'UPDATE sessions SET parent_session_id = ?, updated_at = ?, last_activity_at = ? WHERE session_id = ?',
        args: [input.parentSessionId, now, now, input.childSessionId],
    });
    await client.execute({
        sql:
            'INSERT OR REPLACE INTO session_awaits ' +
            '(wait_id, session_id, reason, source_kind, source_id, job_id, child_session_id, status, created_at, metadata_json) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [
            input.childSessionId,
            input.parentSessionId,
            'subagent',
            'child_session',
            input.childSessionId,
            input.childSessionId,
            input.childSessionId,
            'pending',
            now,
            JSON.stringify({ mode: input.mode }),
        ],
    });
    await client.execute({
        sql:
            'INSERT INTO session_relations ' +
            '(relation_id, parent_session_id, child_session_id, kind, created_at, metadata_json) ' +
            'VALUES (?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(parent_session_id, child_session_id, kind) DO UPDATE SET created_at = excluded.created_at, ' +
            'metadata_json = excluded.metadata_json',
        args: [
            `${input.parentSessionId}:${input.childSessionId}:subagent`,
            input.parentSessionId,
            input.childSessionId,
            'subagent',
            now,
            JSON.stringify({ agentId: input.agentId ?? null, mode: input.mode }),
        ],
    });
    await persistSessionAwaiting({
        client,
        sessionId: input.parentSessionId,
        reason: 'subagent',
        waitId: input.childSessionId,
        now,
    });
    await upsertJobRow({
        client,
        handle: {
            jobId: input.childSessionId,
            sessionId: input.childSessionId,
            parentSessionId: input.parentSessionId,
            ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
            blocking: true,
            status: 'running',
            startedAt: now,
        },
    });
}

export async function resolveSubagentWaitWithJob(
    client: Client,
    input: ResolveSubagentWaitInput,
    now: string,
): Promise<void> {
    await ensurePublicSessionRow({ client, sessionId: input.parentSessionId, now });
    await ensurePublicSessionRow({ client, sessionId: input.childSessionId, now });
    await client.execute({
        sql:
            'UPDATE session_awaits SET status = ?, resolved_at = ? ' +
            'WHERE session_id = ? AND child_session_id = ? AND status = ?',
        args: ['resolved', now, input.parentSessionId, input.childSessionId, 'pending'],
    });
    await upsertJobRow({ client, handle: resolvedSubagentJob(input, now) });
    await refreshSessionAwaitingFromPendingWaits({ client, sessionId: input.parentSessionId, now });
}
