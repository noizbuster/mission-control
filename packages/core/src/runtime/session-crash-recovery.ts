/**
 * Startup reconciliation for sessions orphaned by a host-process crash.
 *
 * When the `mc` process dies abruptly (an `unhandledRejection`/`uncaughtException` before
 * the crash guard existed, a SIGKILL, or a native-core abort), its interactive session is
 * left at `running`/`awaiting` with no terminal event: no `run.failed`, no `session.stopped`.
 * The owning process is gone but the row never transitions, so `mc sessions` shows a zombie
 * forever and resume logic cannot tell the run was lost.
 *
 * `reconcileCrashedSessions` runs once at startup. For every live-looking session it requires
 * TWO independent proofs that the owner is gone before touching it, so a merely busy sibling
 * process is never falsely stopped:
 *   1. the session-control lease is expired past a grace window (a live owner renews every 5s
 *      with a 15s TTL, so an expired lease means no renewal has run), AND
 *   2. the recorded owner pid is provably dead or reused (`probeSessionControlProcess` returns
 *      `dead`/`mismatched`); `matching`/`unknown` sessions are left untouched.
 *
 * Reconciliation reuses the proven durable-stop primitives (`applyStopMutation` +
 * `appendFencedSessionStopEvent`) so the session lands in the exact same `stopped` state as an
 * explicit `mc session stop`, and the terminal event survives later event-stream re-projection.
 */
import type { Client } from '@libsql/client';
import type { AgentEvent } from '@mission-control/protocol';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { drizzleFromClient } from '../db/drizzle-client';
import { openMissionControlDb } from '../db/mission-control-db';
import { sessionControlLeases, sessions } from '../db/schema';
import { probeSessionControlProcess } from './session-control-process';
import { appendFencedSessionStopEvent } from './session-stop-event-writer';
import { applyStopMutation, readSessionTerminalStatus } from './session-stop-mutation';

export const CRASH_RECOVERY_LEASE_GRACE_MS = 30_000;

export type ReconcileCrashedSessionsOptions = {
    readonly dataDir: string;
    readonly nowMs?: () => number;
    readonly graceMs?: number;
    /** Override the DB opener (tests inject an in-memory client). */
    readonly openClient?: (dataDir: string) => Promise<{ readonly client: Client; readonly close: () => void }>;
    /** Override the pid probe (tests inject deterministic liveness). */
    readonly probeProcess?: typeof probeSessionControlProcess;
};

export type ReconcileCrashedSessionsResult = {
    readonly reconciled: readonly string[];
    readonly skipped: readonly string[];
};

export async function reconcileCrashedSessions(
    options: ReconcileCrashedSessionsOptions,
): Promise<ReconcileCrashedSessionsResult> {
    const nowMs = options.nowMs ?? Date.now;
    const graceMs = options.graceMs ?? CRASH_RECOVERY_LEASE_GRACE_MS;
    const openClient =
        options.openClient ??
        (async (dataDir: string) => {
            const db = await openMissionControlDb({ dataDir });
            return { client: db.client, close: () => db.close() };
        });

    try {
        const handle = await openClient(options.dataDir);
        try {
            return await reconcileWithClient({
                client: handle.client,
                nowMs,
                graceMs,
                probe: options.probeProcess ?? probeSessionControlProcess,
            });
        } finally {
            handle.close();
        }
    } catch {
        // Reconciliation is best-effort startup maintenance; it must never block the CLI.
        return { reconciled: [], skipped: [] };
    }
}

async function reconcileWithClient(input: {
    readonly client: Client;
    readonly nowMs: () => number;
    readonly graceMs: number;
    readonly probe: typeof probeSessionControlProcess;
}): Promise<ReconcileCrashedSessionsResult> {
    const now = input.nowMs();
    const expiryThreshold = now - input.graceMs;
    const db = drizzleFromClient(input.client);
    const candidates = await db
        .select({
            sessionId: sessions.sessionId,
            pid: sessionControlLeases.pid,
            processStartId: sessionControlLeases.processStartId,
        })
        .from(sessions)
        .innerJoin(sessionControlLeases, eq(sessionControlLeases.sessionId, sessions.sessionId))
        .where(and(inArray(sessions.status, ['running', 'awaiting']), lt(sessionControlLeases.expiresWallMs, expiryThreshold)));

    const reconciled: string[] = [];
    const skipped: string[] = [];
    for (const row of candidates) {
        const sessionId = row.sessionId;
        const pid = row.pid;
        const processStartId = row.processStartId;
        // Second proof: the owner process must be provably gone. A live (matching) or
        // indeterminate (unknown) owner is never touched.
        const state = await input.probe(pid, processStartId);
        if (state !== 'dead' && state !== 'mismatched') {
            skipped.push(sessionId);
            continue;
        }
        // A concurrent stop may have terminalized the session between the select and here.
        const terminal = await readSessionTerminalStatus(input.client, sessionId);
        if (terminal !== 'active') {
            skipped.push(sessionId);
            continue;
        }
        const timestamp = new Date(now).toISOString();
        await applyStopMutation({ client: input.client, sessionId, timestamp });
        const event: AgentEvent = {
            type: 'session.stopped',
            timestamp,
            sessionId,
            message: 'session stopped (crash recovery: owner process exited)',
        };
        await appendFencedSessionStopEvent({ client: input.client, sessionId, event });
        reconciled.push(sessionId);
    }
    return { reconciled, skipped };
}
