import type { Client } from '@libsql/client';
import {
    ensurePublicSessionRow,
    persistSessionAwaiting,
    refreshSessionAwaitingFromPendingWaits,
} from '../memory/session-awaiting-sql';
import { resolvedSubagentJob } from './agent-job-sql-mirror-handles';
import {
    markChildSessionRunning,
    markChildSessionSettled,
    upsertJobRow,
    upsertSubagentRelation,
} from './agent-job-sql-mirror-persist';
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
    await markChildSessionRunning({
        client,
        sessionId: input.childSessionId,
        parentSessionId: input.parentSessionId,
        now,
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
    await upsertSubagentRelation({
        client,
        parentSessionId: input.parentSessionId,
        childSessionId: input.childSessionId,
        now,
        metadata: { agentId: input.agentId ?? null, mode: input.mode },
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
    await markChildSessionSettled({
        client,
        sessionId: input.childSessionId,
        parentSessionId: input.parentSessionId,
        status: input.status,
        now,
    });
    await client.execute({
        sql:
            'UPDATE session_awaits SET status = ?, resolved_at = ? ' +
            'WHERE session_id = ? AND child_session_id = ? AND status = ?',
        args: ['resolved', now, input.parentSessionId, input.childSessionId, 'pending'],
    });
    await upsertJobRow({ client, handle: resolvedSubagentJob(input, now) });
    await refreshSessionAwaitingFromPendingWaits({ client, sessionId: input.parentSessionId, now });
}
