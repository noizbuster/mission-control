import { afterEach, describe, expect, it } from 'vitest';
import { runWithLocalLibsqlWriteLock } from '../db/local-libsql-db.js';
import { openCanonicalRuntimeDb } from './local-runtime-db.js';
import { acquireSessionControlLease } from './session-control-lease.js';
import { createSessionControlOperation, readSessionControlOperation } from './session-control-operation.js';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('canonical runtime DB session-control maintenance', () => {
    it('recovers expired operations on startup and composes hourly GC with runtime cleanup', async () => {
        // Given
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-runtime-control-maintenance-'));
        tempDirectories.push(dataDir);
        const first = await openCanonicalRuntimeDb({
            dataDir,
            sessionControlMaintenance: false,
        });
        const lease = (
            await acquireSessionControlLease({
                runtime: first.runtime,
                dbIdentity: first.identity.dbIdentity,
                sessionId: 'session-maintenance',
                ownerId: 'owner-maintenance',
                nonceHash: createHash('sha256').update('maintenance').digest('hex'),
                pid: process.pid,
                processStartId: 'process-maintenance',
                nowWallMs: 1_000,
            })
        ).lease;
        await createSessionControlOperation({
            runtime: first.runtime,
            lease,
            operationId: 'operation-maintenance',
            barrierKind: 'all_mutations',
            deadlineWallMs: 1_500,
            capturedHandleIds: [],
            nowWallMs: 1_100,
        });
        first.runtime.close();
        let scheduled: (() => void | Promise<void>) | undefined;
        let scheduledDelay = 0;
        let cancelled = false;

        // When
        const reopened = await openCanonicalRuntimeDb({
            dataDir,
            sessionControlMaintenance: {
                nowWallMs: () => 2_000,
                schedule: (callback, delayMs) => {
                    scheduled = callback;
                    scheduledDelay = delayMs;
                    return callback;
                },
                cancel: () => {
                    cancelled = true;
                },
            },
        });

        // Then
        expect(
            await readSessionControlOperation(
                reopened.runtime,
                reopened.identity.dbIdentity,
                'session-maintenance',
                'operation-maintenance',
            ),
        ).toMatchObject({ status: 'timed_out', receipt: { outcome: 'failed', errorCode: 'stop_timeout' } });
        expect(scheduledDelay).toBe(60 * 60 * 1_000);
        await scheduled?.();
        reopened.runtime.close();
        expect(cancelled).toBe(true);
    });

    it('keeps the shared client alive while in-flight maintenance drains its lease', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-runtime-control-close-race-'));
        tempDirectories.push(dataDir);
        let scheduled: (() => void | Promise<void>) | undefined;
        const opened = await openCanonicalRuntimeDb({
            dataDir,
            sessionControlMaintenance: {
                nowWallMs: () => 2_000,
                schedule: (callback) => {
                    scheduled = callback;
                    return callback;
                },
                cancel: () => undefined,
            },
        });
        let releaseWrite: () => void = () => undefined;
        let writeStarted: () => void = () => undefined;
        const started = new Promise<void>((resolve) => {
            writeStarted = resolve;
        });
        const blocker = runWithLocalLibsqlWriteLock(opened.runtime.writeKey, async () => {
            writeStarted();
            await new Promise<void>((resolve) => {
                releaseWrite = resolve;
            });
        });
        await started;
        const tick = scheduled?.();

        opened.runtime.close();
        await expect(opened.runtime.client.execute('SELECT 1')).resolves.toBeDefined();
        const reopen = openCanonicalRuntimeDb({ dataDir, sessionControlMaintenance: false });
        releaseWrite();
        await blocker;
        await tick;
        const reopened = await reopen;
        await expect(reopened.runtime.client.execute('SELECT 1')).resolves.toBeDefined();
        reopened.runtime.close();
    });
});
