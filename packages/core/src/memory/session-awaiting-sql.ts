import type { Client } from '@libsql/client';
import { z } from 'zod';
import {
    deriveSessionLifecycle,
    type SessionActiveRun,
    type SessionLifecycleDerivation,
    type SessionTerminalEvent,
} from './session-status-derivation.js';

type SessionAwaitingReason = 'approval' | 'user_input' | 'subagent';

const pendingWaitRowSchema = z
    .object({
        wait_id: z.string(),
        reason: z.enum(['approval', 'user_input', 'subagent']),
    })
    .strict();
const sessionLifecycleRowSchema = z
    .object({
        status: z.enum(['idle', 'running', 'awaiting', 'stopped', 'failed']),
        stopped_at: z.string().nullable(),
        failed_at: z.string().nullable(),
    })
    .strict();
const activeRunRowSchema = z
    .object({
        run_id: z.string(),
    })
    .strict();
const tablePresenceRowSchema = z
    .object({
        count: z.number(),
    })
    .strict();

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
    const result = await input.client.execute({
        sql:
            'SELECT wait_id, reason FROM session_awaits WHERE session_id = ? AND status = ? ' +
            'ORDER BY CASE reason WHEN ? THEN 0 WHEN ? THEN 1 WHEN ? THEN 2 ELSE 3 END, created_at, wait_id LIMIT 1',
        args: [input.sessionId, 'pending', 'approval', 'user_input', 'subagent'],
    });
    const pending = result.rows[0] === undefined ? undefined : pendingWaitRowSchema.parse(result.rows[0]);
    if (pending === undefined) {
        const lifecycle = deriveSessionLifecycle({
            terminalEvent: await loadSessionTerminalEvent(input),
            activeRuns: await loadSessionActiveRuns(input),
            pendingWaits: [],
            backgroundJobs: [],
        });
        await input.client.execute({
            sql:
                'UPDATE sessions SET status = CASE WHEN status IN (?, ?) THEN status ELSE ? END, ' +
                'awaiting_reason = NULL, primary_wait_id = NULL, updated_at = ?, last_activity_at = ? ' +
                'WHERE session_id = ?',
            args: ['stopped', 'failed', statusForClearedAwaiting(lifecycle), input.now, input.now, input.sessionId],
        });
        return;
    }
    await persistSessionAwaiting({
        client: input.client,
        sessionId: input.sessionId,
        reason: pending.reason,
        waitId: pending.wait_id,
        now: input.now,
    });
}

export async function loadSessionTerminalEvent(input: {
    readonly client: Client;
    readonly sessionId: string;
}): Promise<SessionTerminalEvent> {
    const result = await input.client.execute({
        sql: 'SELECT status, stopped_at, failed_at FROM sessions WHERE session_id = ?',
        args: [input.sessionId],
    });
    const row = result.rows[0];
    if (row === undefined) {
        return { kind: 'none' };
    }
    const session = sessionLifecycleRowSchema.parse(row);
    switch (session.status) {
        case 'failed':
            return { kind: 'failed' };
        case 'stopped':
            return { kind: 'stopped' };
        case 'idle':
        case 'running':
        case 'awaiting':
            break;
        default:
            return assertNever(session.status);
    }
    if (session.failed_at !== null) {
        return { kind: 'failed' };
    }
    if (session.stopped_at !== null) {
        return { kind: 'stopped' };
    }
    return { kind: 'none' };
}

export async function loadSessionActiveRuns(input: {
    readonly client: Client;
    readonly sessionId: string;
}): Promise<readonly SessionActiveRun[]> {
    if (!(await missionRunsTableExists(input.client))) {
        return [];
    }
    const result = await input.client.execute({
        sql:
            'SELECT run_id FROM mission_runs WHERE session_id = ? AND status IN (?, ?, ?) ' +
            'ORDER BY created_at, run_id',
        args: [input.sessionId, 'pending', 'running', 'blocked'],
    });
    return result.rows.map((row) => ({ runId: activeRunRowSchema.parse(row).run_id }));
}

async function missionRunsTableExists(client: Client): Promise<boolean> {
    const result = await client.execute({
        sql: 'SELECT COUNT(*) AS count FROM sqlite_master WHERE type = ? AND name = ?',
        args: ['table', 'mission_runs'],
    });
    return tablePresenceRowSchema.parse(result.rows[0]).count > 0;
}

function statusForClearedAwaiting(lifecycle: SessionLifecycleDerivation): 'idle' | 'running' | 'stopped' | 'failed' {
    switch (lifecycle.status) {
        case 'idle':
        case 'running':
        case 'stopped':
            return lifecycle.status;
        case 'failed':
            return lifecycle.status;
        case 'awaiting':
            return 'idle';
        default:
            return assertNever(lifecycle);
    }
}

function assertNever(value: never): never {
    throw new Error(`unhandled variant: ${String(value)}`);
}
