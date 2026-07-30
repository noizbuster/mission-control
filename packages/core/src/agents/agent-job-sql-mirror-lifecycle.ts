import type { Client } from '@libsql/client';
import { and, eq } from 'drizzle-orm';
import { drizzleFromClient } from '../db/drizzle-client';
import { sessionAwaits } from '../db/schema';
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
import type { DurableBackgroundJobHandle } from './async-job-manager';

export async function recordJobWithLifecycle(client: Client, handle: DurableBackgroundJobHandle): Promise<void> {
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
    const db = drizzleFromClient(client);
    const metadataJson = JSON.stringify({ mode: input.mode });
    await db
        .insert(sessionAwaits)
        .values({
            waitId: input.childSessionId,
            sessionId: input.parentSessionId,
            reason: 'subagent',
            sourceKind: 'child_session',
            sourceId: input.childSessionId,
            jobId: input.childSessionId,
            childSessionId: input.childSessionId,
            status: 'pending',
            createdAt: now,
            metadataJson,
        })
        .onConflictDoUpdate({
            target: sessionAwaits.waitId,
            set: {
                sessionId: input.parentSessionId,
                reason: 'subagent',
                sourceKind: 'child_session',
                sourceId: input.childSessionId,
                runId: null,
                toolCallId: null,
                approvalId: null,
                jobId: input.childSessionId,
                childSessionId: input.childSessionId,
                status: 'pending',
                createdAt: now,
                resolvedAt: null,
                cancelledAt: null,
                metadataJson,
            },
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
    const db = drizzleFromClient(client);
    await db
        .update(sessionAwaits)
        .set({
            status: 'resolved',
            resolvedAt: now,
        })
        .where(
            and(
                eq(sessionAwaits.sessionId, input.parentSessionId),
                eq(sessionAwaits.childSessionId, input.childSessionId),
                eq(sessionAwaits.status, 'pending'),
            ),
        );
    await upsertJobRow({ client, handle: resolvedSubagentJob(input, now) });
    await refreshSessionAwaitingFromPendingWaits({ client, sessionId: input.parentSessionId, now });
}
