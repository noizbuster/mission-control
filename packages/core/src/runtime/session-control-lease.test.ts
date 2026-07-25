import { afterEach, describe, expect, it } from 'vitest';
import { type LocalLibsqlDb, openLocalLibsqlDb } from '../db/local-libsql-db';
import {
    acquireSessionControlLease,
    readSessionControlLease,
    renewSessionControlLease,
    runWithSessionControlLeaseFence,
    SessionControlLeaseError,
} from './session-control-lease';
import { SESSION_CONTROL_RENEW_INTERVAL_MS, startSessionControlLeaseRenewer } from './session-control-lease-renewer';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB_IDENTITY = 'a'.repeat(64);
const SESSION_ID = 'session-control-lease';
const tempDirs: string[] = [];

async function createRuntime(): Promise<LocalLibsqlDb> {
    const directory = await mkdtemp(join(tmpdir(), 'mctrl-control-lease-'));
    tempDirs.push(directory);
    return openLocalLibsqlDb({ url: `file:${join(directory, 'mission-control.db')}` });
}

function acquisition(runtime: LocalLibsqlDb, ownerId: string, nowWallMs: number) {
    return acquireSessionControlLease({
        runtime,
        dbIdentity: DB_IDENTITY,
        sessionId: SESSION_ID,
        ownerId,
        nonceHash: createHash('sha256').update(ownerId).digest('hex'),
        pid: process.pid,
        processStartId: `start-${ownerId}`,
        nowWallMs,
    });
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('session control lease store', () => {
    it('creates the exact DB-namespaced lease schema', async () => {
        const runtime = await createRuntime();

        const columns = await runtime.client.execute("PRAGMA table_info('session_control_leases')");
        runtime.close();

        // biome-ignore lint/complexity/useLiteralKeys: libSQL rows expose pragma columns through an index signature.
        expect(columns.rows.map((row) => row['name'])).toEqual([
            'db_identity',
            'session_id',
            'owner_id',
            'epoch',
            'nonce_hash',
            'pid',
            'process_start_id',
            'heartbeat_wall_ms',
            'expires_wall_ms',
        ]);
        // biome-ignore lint/complexity/useLiteralKeys: libSQL rows expose pragma columns through an index signature.
        expect(columns.rows.filter((row) => Number(row['pk']) > 0).map((row) => row['name'])).toEqual([
            'db_identity',
            'session_id',
        ]);
    });

    it('acquires epoch one and refuses a second live owner', async () => {
        const runtime = await createRuntime();

        const first = await acquisition(runtime, 'owner-one', 1_000);
        const whenSecondAcquires = acquisition(runtime, 'owner-two', 2_000);

        expect(first.previous).toBeUndefined();
        expect(first.lease).toMatchObject({ ownerId: 'owner-one', epoch: 1, expiresWallMs: 16_000 });
        await expect(whenSecondAcquires).rejects.toMatchObject({
            code: 'session_owned_elsewhere',
        } satisfies Partial<SessionControlLeaseError>);
        runtime.close();
    });

    it('allows the same session id to have independent owners in independent databases', async () => {
        const firstRuntime = await createRuntime();
        const secondRuntime = await createRuntime();

        const [first, second] = await Promise.all([
            acquisition(firstRuntime, 'owner-one', 1_000),
            acquisition(secondRuntime, 'owner-two', 1_000),
        ]);

        expect(first.lease.epoch).toBe(1);
        expect(second.lease.epoch).toBe(1);
        firstRuntime.close();
        secondRuntime.close();
    });

    it('renews only a matching, unexpired owner epoch', async () => {
        const runtime = await createRuntime();
        const acquired = await acquisition(runtime, 'owner-one', 1_000);

        const renewed = await renewSessionControlLease({
            runtime,
            lease: acquired.lease,
            nowWallMs: 6_000,
        });
        const staleEpoch = await renewSessionControlLease({
            runtime,
            lease: { ...acquired.lease, epoch: acquired.lease.epoch + 1 },
            nowWallMs: 7_000,
        });
        const afterExpiry = await renewSessionControlLease({
            runtime,
            lease: renewed ?? acquired.lease,
            nowWallMs: 22_000,
        });

        expect(renewed).toMatchObject({ heartbeatWallMs: 6_000, expiresWallMs: 21_000 });
        expect(staleEpoch).toBeUndefined();
        expect(afterExpiry).toBeUndefined();
        runtime.close();
    });

    it('increments epoch on expired takeover and fences every old mutation', async () => {
        const runtime = await createRuntime();
        const first = await acquisition(runtime, 'owner-one', 1_000);
        const second = await acquisition(runtime, 'owner-two', 16_000);

        await expect(
            runWithSessionControlLeaseFence({
                runtime,
                lease: first.lease,
                nowWallMs: 16_001,
                write: (client) => client.execute('SELECT 1'),
            }),
        ).rejects.toMatchObject({ code: 'lease_fenced' } satisfies Partial<SessionControlLeaseError>);
        await expect(
            runWithSessionControlLeaseFence({
                runtime,
                lease: second.lease,
                nowWallMs: 16_001,
                write: (client) => client.execute('SELECT 1'),
            }),
        ).resolves.toBeDefined();

        expect(second.previous).toMatchObject({ ownerId: 'owner-one', epoch: 1 });
        expect(second.lease).toMatchObject({ ownerId: 'owner-two', epoch: 2 });
        expect(await readSessionControlLease(runtime, DB_IDENTITY, SESSION_ID)).toMatchObject({ epoch: 2 });
        runtime.close();
    });

    it('selects exactly one winner for concurrent expired takeover', async () => {
        const runtime = await createRuntime();
        await acquisition(runtime, 'owner-one', 1_000);

        const attempts = await Promise.allSettled([
            acquisition(runtime, 'owner-two', 16_000),
            acquisition(runtime, 'owner-three', 16_000),
        ]);

        expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
        expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
        runtime.close();
    });

    it('schedules five-second renewal from a local monotonic clock and self-fences on CAS loss', async () => {
        let monotonicMs = 100;
        let scheduledDelay = 0;
        let scheduled: (() => void | Promise<void>) | undefined;
        let renews = 0;
        let fenced = false;
        const renewer = startSessionControlLeaseRenewer({
            monotonicNow: () => monotonicMs,
            schedule: (callback, delayMs) => {
                scheduled = callback;
                scheduledDelay = delayMs;
                return callback;
            },
            cancel: () => undefined,
            renew: async () => {
                renews += 1;
                return renews === 1;
            },
            onFenced: () => {
                fenced = true;
            },
        });

        expect(scheduledDelay).toBe(SESSION_CONTROL_RENEW_INTERVAL_MS);
        monotonicMs += SESSION_CONTROL_RENEW_INTERVAL_MS;
        await scheduled?.();
        expect(scheduledDelay).toBe(SESSION_CONTROL_RENEW_INTERVAL_MS);
        monotonicMs += SESSION_CONTROL_RENEW_INTERVAL_MS;
        await scheduled?.();
        expect(fenced).toBe(true);

        renewer.stop();
    });

    it('retries transient renewal errors without aborting a live owner', async () => {
        let monotonicMs = 100;
        let scheduledDelay = 0;
        let scheduled: (() => void | Promise<void>) | undefined;
        let renews = 0;
        let fenced = false;
        const renewer = startSessionControlLeaseRenewer({
            monotonicNow: () => monotonicMs,
            schedule: (callback, delayMs) => {
                scheduled = callback;
                scheduledDelay = delayMs;
                return callback;
            },
            cancel: () => undefined,
            transientErrorRetryMs: 1_000,
            renew: async () => {
                renews += 1;
                if (renews === 1) throw new Error('database busy');
                return true;
            },
            onFenced: () => {
                fenced = true;
            },
        });

        monotonicMs += SESSION_CONTROL_RENEW_INTERVAL_MS;
        await scheduled?.();
        expect(fenced).toBe(false);
        expect(scheduledDelay).toBe(1_000);

        monotonicMs += 1_000;
        await scheduled?.();
        expect(renews).toBe(2);
        expect(fenced).toBe(false);
        expect(scheduledDelay).toBe(SESSION_CONTROL_RENEW_INTERVAL_MS);

        renewer.stop();
    });

    it('self-fences when transient renewal errors exhaust the retry budget', async () => {
        let monotonicMs = 100;
        let scheduled: (() => void | Promise<void>) | undefined;
        let fenced = false;
        const renewer = startSessionControlLeaseRenewer({
            monotonicNow: () => monotonicMs,
            schedule: (callback) => {
                scheduled = callback;
                return callback;
            },
            cancel: () => undefined,
            transientErrorRetryMs: 1_000,
            maxTransientErrors: 1,
            renew: async () => {
                throw new Error('database busy');
            },
            onFenced: () => {
                fenced = true;
            },
        });

        monotonicMs += SESSION_CONTROL_RENEW_INTERVAL_MS;
        await scheduled?.();
        expect(fenced).toBe(false);

        monotonicMs += 1_000;
        await scheduled?.();
        expect(fenced).toBe(true);

        renewer.stop();
    });
});
