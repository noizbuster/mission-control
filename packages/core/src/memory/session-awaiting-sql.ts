import type { Client } from '@libsql/client';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import { drizzleFromClient } from '../db/drizzle-client';
import { sessions } from '../db/schema';
import { deriveSessionLifecycleFromSql } from './session-lifecycle-sql-authorities';

export { loadSessionActiveRuns, loadSessionTerminalEvent } from './session-lifecycle-sql-authorities';

type SessionAwaitingReason = 'approval' | 'user_input' | 'subagent';

export type PersistSessionAwaitingInput = {
    readonly client: Client;
    readonly sessionId: string;
    readonly reason: SessionAwaitingReason;
    readonly waitId: string;
    readonly now: string;
};

export async function ensurePublicSessionRow(input: {
    readonly client: Client;
    readonly sessionId: string;
    readonly now: string;
}): Promise<void> {
    const db = drizzleFromClient(input.client);
    await db
        .insert(sessions)
        .values({
            sessionId: input.sessionId,
            status: 'idle',
            createdAt: input.now,
            updatedAt: input.now,
            lastActivityAt: input.now,
        })
        .onConflictDoNothing({ target: sessions.sessionId });
}

export async function persistSessionAwaiting(input: PersistSessionAwaitingInput): Promise<void> {
    await ensurePublicSessionRow(input);
    const db = drizzleFromClient(input.client);
    await db
        .update(sessions)
        .set({
            status: 'awaiting',
            awaitingReason: input.reason,
            primaryWaitId: input.waitId,
            updatedAt: input.now,
            lastActivityAt: input.now,
        })
        .where(and(eq(sessions.sessionId, input.sessionId), notInArray(sessions.status, ['stopped', 'failed'])));
}

export async function refreshSessionAwaitingFromPendingWaits(input: {
    readonly client: Client;
    readonly sessionId: string;
    readonly now: string;
}): Promise<void> {
    await ensurePublicSessionRow(input);
    const lifecycle = await deriveSessionLifecycleFromSql(input);
    const awaitingReason = lifecycle.status === 'awaiting' ? lifecycle.awaitingReason : null;
    const primaryWaitId = lifecycle.status === 'awaiting' ? lifecycle.primaryWaitId : null;
    const lifecycleReason = lifecycle.status === 'idle' && lifecycle.displayReason === 'aborted' ? 'aborted' : null;
    const db = drizzleFromClient(input.client);
    await db
        .update(sessions)
        .set({
            status: sql`CASE WHEN ${sessions.status} IN ('stopped', 'failed') THEN ${sessions.status} ELSE ${lifecycle.status} END`,
            awaitingReason,
            primaryWaitId,
            updatedAt: input.now,
            lastActivityAt: input.now,
            metadataJson: sql`CASE
                WHEN ${lifecycleReason} IS NULL THEN json_remove(
                    CASE WHEN json_valid(${sessions.metadataJson}) THEN ${sessions.metadataJson} ELSE '{}' END,
                    '$.lifecycleReason'
                )
                ELSE json_set(
                    CASE WHEN json_valid(${sessions.metadataJson}) THEN ${sessions.metadataJson} ELSE '{}' END,
                    '$.lifecycleReason',
                    ${lifecycleReason}
                )
            END`,
        })
        .where(eq(sessions.sessionId, input.sessionId));
}
