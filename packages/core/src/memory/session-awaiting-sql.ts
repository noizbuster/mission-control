import type { Client } from '@libsql/client';
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
    await input.client.execute({
        sql:
            'INSERT INTO sessions (session_id, status, created_at, updated_at, last_activity_at) ' +
            'VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING',
        args: [input.sessionId, 'idle', input.now, input.now, input.now],
    });
}

export async function persistSessionAwaiting(input: PersistSessionAwaitingInput): Promise<void> {
    await ensurePublicSessionRow(input);
    await input.client.execute({
        sql:
            'UPDATE sessions SET status = ?, awaiting_reason = ?, primary_wait_id = ?, updated_at = ?, ' +
            'last_activity_at = ? WHERE session_id = ? AND status NOT IN (?, ?)',
        args: ['awaiting', input.reason, input.waitId, input.now, input.now, input.sessionId, 'stopped', 'failed'],
    });
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
    await input.client.execute({
        sql: `
            UPDATE sessions
            SET status = CASE WHEN status IN (?, ?) THEN status ELSE ? END,
                awaiting_reason = ?, primary_wait_id = ?,
                updated_at = ?, last_activity_at = ?,
                metadata_json = CASE
                    WHEN ? IS NULL THEN json_remove(
                        CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
                        '$.lifecycleReason'
                    )
                    ELSE json_set(
                        CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,
                        '$.lifecycleReason', ?
                    )
                END
            WHERE session_id = ?
        `,
        args: [
            'stopped',
            'failed',
            lifecycle.status,
            awaitingReason,
            primaryWaitId,
            input.now,
            input.now,
            lifecycleReason,
            lifecycleReason,
            input.sessionId,
        ],
    });
}
