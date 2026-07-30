import type { Client } from '@libsql/client';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import { drizzleFromClient } from '../db/drizzle-client';
import { asyncJobs, runtimeAgents, sessionRelations, sessions } from '../db/schema';
import { ensurePublicSessionRow } from '../memory/session-awaiting-sql';
import { ensureSessionWithIdentity } from '../memory/session-identity-sql';
import { runtimeStatusToDb } from './agent-job-sql-mirror-rows';
import type { DurableBackgroundJobHandle } from './async-job-manager';
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
    const db = drizzleFromClient(input.client);
    const metadataJson = JSON.stringify({
        displayName: input.ref.displayName,
        ...(input.ref.sessionFile !== undefined ? { sessionFile: input.ref.sessionFile } : {}),
        ...(input.ref.authorityFingerprint !== undefined
            ? { authorityFingerprint: input.ref.authorityFingerprint }
            : {}),
        ...(input.ref.taskDepth !== undefined ? { taskDepth: input.ref.taskDepth } : {}),
        ...(input.ref.category !== undefined ? { category: input.ref.category } : {}),
        ...(input.ref.title !== undefined ? { title: input.ref.title } : {}),
    });
    const status = runtimeStatusToDb(input.ref.status);
    const parentAgentId = input.ref.parentId ?? null;
    const activity = input.ref.activity ?? null;
    await db
        .insert(runtimeAgents)
        .values({
            agentId: input.ref.id,
            kind: input.ref.kind,
            sessionId: input.ref.sessionId,
            parentAgentId,
            status,
            activity,
            createdAt: input.ref.createdAt,
            updatedAt: input.ref.lastActivity,
            metadataJson,
        })
        .onConflictDoUpdate({
            target: runtimeAgents.agentId,
            set: {
                kind: input.ref.kind,
                sessionId: input.ref.sessionId,
                parentAgentId,
                status,
                activity,
                updatedAt: input.ref.lastActivity,
                metadataJson,
            },
        });
}

export async function upsertJobRow(input: {
    readonly client: Client;
    readonly handle: DurableBackgroundJobHandle;
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
    const db = drizzleFromClient(input.client);
    const parentSessionId = input.handle.parentSessionId ?? null;
    const agentId = input.handle.agentId ?? null;
    const startedAt = input.handle.status === 'queued' ? null : input.handle.startedAt;
    const completedAt = input.handle.status === 'completed' ? terminalAt : null;
    const failedAt = input.handle.status === 'failed' ? terminalAt : null;
    const cancelledAt = input.handle.status === 'cancelled' ? terminalAt : null;
    const cancellationReason = input.handle.cancellationReason ?? null;
    const resultJson = input.handle.result === undefined ? null : JSON.stringify(input.handle.result);
    const metadataJson = JSON.stringify({ blocking: input.handle.blocking });
    await db
        .insert(asyncJobs)
        .values({
            jobId: input.handle.jobId,
            parentSessionId,
            childSessionId: input.handle.sessionId,
            agentId,
            status: input.handle.status,
            queuedAt: input.handle.startedAt,
            startedAt,
            completedAt,
            failedAt,
            cancelledAt,
            cancellationReason,
            resultJson,
            errorJson: null,
            metadataJson,
        })
        .onConflictDoUpdate({
            target: asyncJobs.jobId,
            set: {
                parentSessionId,
                childSessionId: input.handle.sessionId,
                agentId,
                status: input.handle.status,
                startedAt,
                completedAt,
                failedAt,
                cancelledAt,
                cancellationReason,
                resultJson,
                errorJson: null,
                metadataJson,
            },
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
    const db = drizzleFromClient(input.client);
    await db
        .update(sessions)
        .set({
            parentSessionId: input.parentSessionId,
            status: 'running',
            updatedAt: input.now,
            lastActivityAt: input.now,
        })
        .where(and(eq(sessions.sessionId, input.sessionId), notInArray(sessions.status, ['stopped', 'failed'])));
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
    const db = drizzleFromClient(input.client);
    await db
        .update(sessions)
        .set({
            parentSessionId: sql`COALESCE(${sessions.parentSessionId}, ${input.parentSessionId})`,
            status: sessionStatus,
            failedAt: sql`CASE WHEN ${sessionStatus} = ${'failed'} THEN COALESCE(${sessions.failedAt}, ${input.now}) ELSE ${sessions.failedAt} END`,
            updatedAt: input.now,
            lastActivityAt: input.now,
        })
        .where(and(eq(sessions.sessionId, input.sessionId), notInArray(sessions.status, ['stopped'])));
}

export async function upsertSubagentRelation(input: {
    readonly client: Client;
    readonly parentSessionId: string;
    readonly childSessionId: string;
    readonly now: string;
    readonly metadata: Readonly<Record<string, string | null>>;
}): Promise<void> {
    const db = drizzleFromClient(input.client);
    const metadataJson = JSON.stringify(input.metadata);
    await db
        .insert(sessionRelations)
        .values({
            relationId: relationId(input.parentSessionId, input.childSessionId, 'subagent'),
            parentSessionId: input.parentSessionId,
            childSessionId: input.childSessionId,
            kind: 'subagent',
            createdAt: input.now,
            metadataJson,
        })
        .onConflictDoUpdate({
            target: [sessionRelations.parentSessionId, sessionRelations.childSessionId, sessionRelations.kind],
            set: {
                createdAt: input.now,
                metadataJson,
            },
        });
}

function relationId(parentSessionId: string, childSessionId: string, kind: string): string {
    return `${parentSessionId}:${childSessionId}:${kind}`;
}
