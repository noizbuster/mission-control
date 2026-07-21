import type { Client } from '@libsql/client';
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
    await patch.client.execute({
        sql:
            'UPDATE sessions SET ' +
            'title = COALESCE(?, title), ' +
            'category = COALESCE(?, category), ' +
            'agent_name = COALESCE(?, agent_name), ' +
            'parent_session_id = COALESCE(?, parent_session_id), ' +
            'updated_at = ?, last_activity_at = ? ' +
            'WHERE session_id = ?',
        args: [
            patch.title ?? null,
            patch.category ?? null,
            patch.agentName ?? null,
            patch.parentSessionId ?? null,
            patch.now,
            patch.now,
            patch.sessionId,
        ],
    });
}
