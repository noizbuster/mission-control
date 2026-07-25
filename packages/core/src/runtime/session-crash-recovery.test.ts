// allow: SIZE_OK -- focused reconciliation contract tests over a real schema-backed libSQL db.

import { RunSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type LocalLibsqlDb, openLocalLibsqlDb } from '../db/local-libsql-db';
import { missionControlDbUrl } from '../memory/local-session-store-paths';
import { writeRunToDb } from './mission-run/mission-run-db';
import type { SessionControlProcessState } from './session-control-process';
import { CRASH_RECOVERY_LEASE_GRACE_MS, reconcileCrashedSessions } from './session-crash-recovery';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB_IDENTITY = 'c'.repeat(64);
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function openRuntime(): Promise<{ readonly runtime: LocalLibsqlDb; readonly dataDir: string }> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-crash-recovery-'));
    directories.push(dataDir);
    const runtime = await openLocalLibsqlDb({ url: missionControlDbUrl(dataDir) });
    return { runtime, dataDir };
}

type Seed = {
    readonly sessionId: string;
    readonly status: 'running' | 'awaiting';
    readonly expiresWallMs: number;
    readonly pid: number;
    readonly processStartId: string;
    readonly missionRunId?: string;
};

async function seed(runtime: LocalLibsqlDb, dataDir: string, seed: Seed): Promise<void> {
    const now = Date.now();
    await runtime.client.execute({
        sql: 'INSERT INTO sessions (session_id, status, created_at, updated_at, last_activity_at) VALUES (?, ?, ?, ?, ?)',
        args: [seed.sessionId, seed.status, now, now, now],
    });
    await runtime.client.execute({
        sql:
            'INSERT INTO session_control_leases ' +
            '(db_identity, session_id, owner_id, epoch, nonce_hash, pid, process_start_id, heartbeat_wall_ms, expires_wall_ms) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [
            DB_IDENTITY,
            seed.sessionId,
            `owner-${seed.sessionId}`,
            1,
            'nonce',
            seed.pid,
            seed.processStartId,
            seed.expiresWallMs,
            seed.expiresWallMs,
        ],
    });
    if (seed.missionRunId !== undefined) {
        await writeRunToDb(
            dataDir,
            RunSchema.parse({
                id: seed.missionRunId,
                missionId: `mission-${seed.sessionId}`,
                sessionId: seed.sessionId,
                status: 'running',
                prompt: 'seed run',
            }),
        );
    }
}

async function sessionStatus(runtime: LocalLibsqlDb, sessionId: string): Promise<string | undefined> {
    const result = await runtime.client.execute({
        sql: 'SELECT status FROM sessions WHERE session_id = ?',
        args: [sessionId],
    });
    const row = result.rows[0];
    return row === undefined ? undefined : String(row['status']);
}

async function missionRunStatus(runtime: LocalLibsqlDb, runId: string): Promise<string | undefined> {
    const result = await runtime.client.execute({
        sql: 'SELECT status FROM mission_runs WHERE run_id = ?',
        args: [runId],
    });
    const row = result.rows[0];
    return row === undefined ? undefined : String(row['status']);
}

async function hasStoppedEvent(runtime: LocalLibsqlDb, sessionId: string): Promise<boolean> {
    const result = await runtime.client.execute({
        sql: "SELECT COUNT(*) AS c FROM session_events WHERE session_id = ? AND type = 'session.stopped'",
        args: [sessionId],
    });
    return Number(result.rows[0]?.['c'] ?? 0) > 0;
}

describe('reconcileCrashedSessions', () => {
    it('stops an orphaned session whose owner process is gone', async () => {
        const { runtime, dataDir } = await openRuntime();
        const now = Date.now();
        await seed(runtime, dataDir, {
            sessionId: 'session-orphan',
            status: 'running',
            expiresWallMs: now - CRASH_RECOVERY_LEASE_GRACE_MS - 1_000,
            pid: 999_999,
            processStartId: 'dead-start',
            missionRunId: 'run-orphan',
        });

        const probe = vi.fn(async (): Promise<SessionControlProcessState> => 'dead');
        const result = await reconcileCrashedSessions({
            dataDir,
            openClient: async () => ({ client: runtime.client, close: () => undefined }),
            probeProcess: probe,
        });

        expect(result.reconciled).toEqual(['session-orphan']);
        expect(await sessionStatus(runtime, 'session-orphan')).toBe('stopped');
        expect(await missionRunStatus(runtime, 'run-orphan')).toBe('cancelled');
        expect(await hasStoppedEvent(runtime, 'session-orphan')).toBe(true);
        runtime.close();
    });

    it('leaves a session alone when its owner process is still alive', async () => {
        const { runtime, dataDir } = await openRuntime();
        const now = Date.now();
        await seed(runtime, dataDir, {
            sessionId: 'session-alive',
            status: 'running',
            expiresWallMs: now - CRASH_RECOVERY_LEASE_GRACE_MS - 1_000,
            pid: 123,
            processStartId: 'live-start',
            missionRunId: 'run-alive',
        });

        const result = await reconcileCrashedSessions({
            dataDir,
            openClient: async () => ({ client: runtime.client, close: () => undefined }),
            probeProcess: async () => 'matching',
        });

        expect(result.reconciled).toEqual([]);
        expect(result.skipped).toEqual(['session-alive']);
        expect(await sessionStatus(runtime, 'session-alive')).toBe('running');
        expect(await missionRunStatus(runtime, 'run-alive')).toBe('running');
        runtime.close();
    });

    it('skips sessions whose lease is still within the grace window', async () => {
        const { runtime, dataDir } = await openRuntime();
        const now = Date.now();
        // Lease expires in the future — not a candidate regardless of pid liveness.
        await seed(runtime, dataDir, {
            sessionId: 'session-fresh',
            status: 'running',
            expiresWallMs: now + 10_000,
            pid: 999_999,
            processStartId: 'fresh-start',
        });

        const result = await reconcileCrashedSessions({
            dataDir,
            openClient: async () => ({ client: runtime.client, close: () => undefined }),
            probeProcess: async () => 'dead',
        });

        expect(result.reconciled).toEqual([]);
        expect(await sessionStatus(runtime, 'session-fresh')).toBe('running');
        runtime.close();
    });

    it('never throws when the database cannot be opened', async () => {
        const result = await reconcileCrashedSessions({
            dataDir: '/no/such/dir',
            openClient: async () => {
                throw new Error('libsql unavailable');
            },
        });
        expect(result).toEqual({ reconciled: [], skipped: [] });
    });
});
