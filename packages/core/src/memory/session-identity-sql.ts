import type { Client } from '@libsql/client';
import { eq, sql } from 'drizzle-orm';
import { drizzleFromClient } from '../db/drizzle-client';
import { sessions } from '../db/schema';
import { ensurePublicSessionRow } from './session-awaiting-sql';

export type SessionIdentityPatch = {
    readonly client: Client;
    readonly sessionId: string;
    readonly now: string;
    readonly title?: string;
    readonly category?: string;
    readonly agentName?: string;
    readonly parentSessionId?: string;
};

export async function ensureSessionWithIdentity(patch: SessionIdentityPatch): Promise<void> {
    await ensurePublicSessionRow({
        client: patch.client,
        sessionId: patch.sessionId,
        now: patch.now,
    });
    const db = drizzleFromClient(patch.client);
    await db
        .update(sessions)
        .set({
            title: sql`COALESCE(${patch.title ?? null}, ${sessions.title})`,
            category: sql`COALESCE(${patch.category ?? null}, ${sessions.category})`,
            agentName: sql`COALESCE(${patch.agentName ?? null}, ${sessions.agentName})`,
            parentSessionId: sql`COALESCE(${patch.parentSessionId ?? null}, ${sessions.parentSessionId})`,
            updatedAt: patch.now,
            lastActivityAt: patch.now,
        })
        .where(eq(sessions.sessionId, patch.sessionId));
}
