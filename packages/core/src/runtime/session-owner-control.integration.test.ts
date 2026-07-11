import { afterEach, describe, expect, it } from 'vitest';
import {
    acquireSessionControlLease,
    expireSessionControlLease,
    readSessionControlLease,
} from './session-control-lease.js';
import { readSessionControlOperation } from './session-control-operation.js';
import { generateSessionControlNonce } from './session-control-registry-auth.js';
import { readSessionControlRegistry } from './session-control-registry-file.js';
import { createSessionOwnerControlClient, SessionOwnerControlClientError } from './session-owner-control-client.js';
import {
    cleanupSessionOwnerControlFixtures,
    createSessionOwnerControlFixture as createFixture,
    wait,
    waitFor,
} from './session-owner-control-test-support.js';
import { createHash } from 'node:crypto';

afterEach(async () => {
    await cleanupSessionOwnerControlFixtures();
});

describe.runIf(process.platform !== 'win32')('authenticated exact-session owner IPC', () => {
    it('retains an acquired operation across reconnect, caches stop, and releases explicitly', async () => {
        const fixture = await createFixture('ipc-reconnect');
        const client = await fixture.client();
        const reconnectClient = await fixture.client();
        const acquireInput = {
            sessionId: fixture.sessionId,
            requestId: 'request-reconnect',
            operationId: 'operation-reconnect',
            kind: 'exact_session_stop',
            timeoutMs: 2_000,
        } as const;
        const [acquired, reacquired] = await Promise.all([
            client.acquire(acquireInput),
            reconnectClient.acquire(acquireInput),
        ]);

        expect(reacquired.token).toEqual(acquired.token);
        const first = await client.stop(acquired.token);
        const replay = await client.stop(acquired.token);

        expect(first).toMatchObject({ outcome: 'already_idle', operationId: 'operation-reconnect' });
        expect(replay).toEqual(first);
        const session = await fixture.runtime.client.execute({
            sql: 'SELECT status FROM sessions WHERE session_id = ?',
            args: [fixture.sessionId],
        });
        const marker = await fixture.runtime.client.execute({
            sql: "SELECT COUNT(*) AS count FROM session_events WHERE session_id = ? AND type = 'session.abort.completed'",
            args: [fixture.sessionId],
        });
        expect(session.rows[0]?.['status']).toBe('idle');
        expect(Number(marker.rows[0]?.['count'])).toBe(1);
        expect(fixture.host.classify(fixture.sessionId).kind).toBe('stopping');
        await expect(client.release(acquired.token)).resolves.toEqual({ released: true });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
        await waitFor(async () => {
            const lease = await readSessionControlLease(fixture.runtime, fixture.dbIdentity, fixture.sessionId);
            return lease === undefined || lease.expiresWallMs <= Date.now();
        });
        await expect(fixture.client()).rejects.toMatchObject({ code: 'ownerless' });
        await fixture.close();
    });

    it('binds the token to operation, session, kind, owner, epoch, and timeout duration', async () => {
        const fixture = await createFixture('ipc-token-binding');
        const client = await fixture.client();
        const acquired = await client.acquire({
            sessionId: fixture.sessionId,
            requestId: 'request-token',
            operationId: 'operation-token',
            kind: 'exact_session_stop',
            timeoutMs: 2_000,
        });
        const mismatched = { ...acquired.token, operationId: 'operation-other' };

        await expect(client.stop(mismatched)).rejects.toMatchObject({ code: 'token_invalid' });
        await client.release(acquired.token);
        await fixture.close();
    });

    it('holds and cleanly releases a child-spawn-only target barrier without stopping the run', async () => {
        const fixture = await createFixture('ipc-child-spawn-barrier', true);
        const client = await fixture.client();
        const acquired = await client.acquire({
            sessionId: fixture.sessionId,
            requestId: 'request-child-spawn-barrier',
            operationId: 'operation-child-spawn-barrier',
            kind: 'exact_session_stop',
            barrierKind: 'child_spawn_only',
            timeoutMs: 2_000,
        });

        expect(fixture.host.classify(fixture.sessionId)).toMatchObject({ kind: 'child_spawn_blocked' });
        expect(() => fixture.host.assertChildSpawnAllowed(fixture.sessionId)).toThrow('child spawning is blocked');
        await expect(fixture.host.acquire(fixture.sessionId)).resolves.toMatchObject({ ownerId: expect.any(String) });
        await expect(client.stop(acquired.token)).rejects.toMatchObject({ code: 'token_invalid' });
        await expect(client.release(acquired.token)).resolves.toEqual({ released: true });

        expect(fixture.host.classify(fixture.sessionId)).toMatchObject({ kind: 'owned' });
        expect(() => fixture.host.assertChildSpawnAllowed(fixture.sessionId)).not.toThrow();
        expect(
            await readSessionControlOperation(
                fixture.runtime,
                fixture.dbIdentity,
                fixture.sessionId,
                'operation-child-spawn-barrier',
            ),
        ).toMatchObject({
            barrierKind: 'child_spawn_only',
            status: 'completed',
            receipt: { outcome: 'barrier_released' },
            barrierReleasedAt: expect.any(Number),
        });
        await fixture.close();
    });

    it('cleanly releases an unstarted exact barrier without a timeout tombstone or session event', async () => {
        const fixture = await createFixture('ipc-unstarted-release', true);
        const client = await fixture.client();
        const acquired = await client.acquire({
            sessionId: fixture.sessionId,
            requestId: 'request-unstarted-release',
            operationId: 'operation-unstarted-release',
            kind: 'exact_session_stop',
            timeoutMs: 2_000,
        });
        const before = await fixture.store.getEvents(fixture.sessionId);

        await expect(client.release(acquired.token)).resolves.toEqual({ released: true });

        expect(await fixture.store.getEvents(fixture.sessionId)).toEqual(before);
        expect(fixture.host.classify(fixture.sessionId)).toMatchObject({ kind: 'owned' });
        expect(
            await readSessionControlOperation(
                fixture.runtime,
                fixture.dbIdentity,
                fixture.sessionId,
                'operation-unstarted-release',
            ),
        ).toMatchObject({ status: 'completed', receipt: { outcome: 'barrier_released' } });
        await fixture.close();
    });

    it('derives the deadline locally, tombstones before auto-release, and evicts the released token', async () => {
        let monotonicMs = 100;
        let scheduledDelay = -1;
        let deadlineCallback: (() => void | Promise<void>) | undefined;
        const fixture = await createFixture('ipc-timeout', true, {
            now: () => new Date(1_000),
            monotonicNow: () => monotonicMs,
            schedule: (callback, delayMs) => {
                deadlineCallback = callback;
                scheduledDelay = delayMs;
                return callback;
            },
            cancel: () => undefined,
        });
        const client = await fixture.client();
        const acquired = await client.acquire({
            sessionId: fixture.sessionId,
            requestId: 'request-timeout',
            operationId: 'operation-timeout',
            kind: 'exact_session_stop',
            timeoutMs: 10,
        });
        expect(scheduledDelay).toBe(10);
        monotonicMs = 110;
        await deadlineCallback?.();

        await expect(client.stop(acquired.token)).rejects.toMatchObject({ code: 'token_invalid' });
        const operation = await readSessionControlOperation(
            fixture.runtime,
            fixture.dbIdentity,
            fixture.sessionId,
            'operation-timeout',
        );

        expect(operation).toMatchObject({
            status: 'timed_out',
            receipt: { outcome: 'failed', errorCode: 'stop_timeout' },
        });
        expect(operation?.barrierReleasedAt).not.toBeNull();
        await fixture.close();
    });

    it('lets a stop exceed the auth timeout and makes concurrent release wait for its response', async () => {
        const fixture = await createFixture('ipc-long-stop');
        let settle: () => void = () => undefined;
        const settled = new Promise<void>((resolve) => {
            settle = resolve;
        });
        await fixture.host.attachEntity({
            sessionId: fixture.sessionId,
            kind: 'run',
            entityId: 'slow-run',
            handles: [
                {
                    kind: 'provider',
                    handleId: 'provider:slow-run',
                    abort: () => {
                        setTimeout(settle, 2_100);
                    },
                    settled,
                },
            ],
        });
        const client = await fixture.client();
        const acquired = await client.acquire({
            sessionId: fixture.sessionId,
            requestId: 'request-long-stop',
            operationId: 'operation-long-stop',
            kind: 'exact_session_stop',
            timeoutMs: 3_000,
        });
        const startedAt = performance.now();

        const [receipt, released] = await Promise.all([
            client.stop(acquired.token),
            wait(20).then(() => client.release(acquired.token)),
        ]);

        expect(performance.now() - startedAt).toBeGreaterThanOrEqual(2_000);
        expect(receipt).toMatchObject({ outcome: 'already_idle' });
        expect(released).toEqual({ released: true });
        await fixture.close();
    });

    it('rejects forged authentication without creating a durable operation', async () => {
        const fixture = await createFixture('ipc-auth');
        const client = await fixture.client();
        const crossProcessClock = {
            sessionId: fixture.sessionId,
            requestId: 'request-clock',
            operationId: 'operation-clock',
            kind: 'exact_session_stop',
            timeoutMs: 100,
            deadlineMonotonicMs: 500,
        } as const;
        const paths = await fixture.paths();
        const registry = await readSessionControlRegistry(paths.registryPath);
        const forged = createSessionOwnerControlClient({ ...registry, nonce: generateSessionControlNonce() });

        await expect(client.acquire(crossProcessClock)).rejects.toMatchObject({ code: 'invalid_request' });
        await expect(
            forged.acquire({
                sessionId: fixture.sessionId,
                requestId: 'request-forged',
                operationId: 'operation-forged',
                kind: 'exact_session_stop',
                timeoutMs: 100,
            }),
        ).rejects.toMatchObject({ code: 'authentication_failed' });
        expect(
            await readSessionControlOperation(
                fixture.runtime,
                fixture.dbIdentity,
                fixture.sessionId,
                'operation-forged',
            ),
        ).toBeUndefined();
        await fixture.close();
    });

    it('classifies owner death and fences an old token from a replacement epoch without session rewrites', async () => {
        const fixture = await createFixture('ipc-fencing');
        const client = await fixture.client();
        const acquired = await client.acquire({
            sessionId: fixture.sessionId,
            requestId: 'request-fencing',
            operationId: 'operation-fencing',
            kind: 'exact_session_stop',
            timeoutMs: 2_000,
        });
        const oldLease = await readSessionControlLease(fixture.runtime, fixture.dbIdentity, fixture.sessionId);
        if (oldLease === undefined) throw new Error('expected live owner lease');
        await expireSessionControlLease({ runtime: fixture.runtime, lease: oldLease, nowWallMs: Date.now() });
        await acquireSessionControlLease({
            runtime: fixture.runtime,
            dbIdentity: fixture.dbIdentity,
            sessionId: fixture.sessionId,
            ownerId: 'replacement-owner',
            nonceHash: createHash('sha256').update('replacement').digest('hex'),
            pid: process.pid,
            processStartId: 'replacement-process',
            nowWallMs: Date.now() + 1,
        });
        await fixture.store.append({
            type: 'run.started',
            timestamp: new Date().toISOString(),
            sessionId: fixture.sessionId,
            run: { command: 'run', state: 'running', runId: 'replacement-run' },
        });

        await expect(client.stop(acquired.token)).resolves.toMatchObject({
            outcome: 'failed',
            errorCode: 'session_owned_elsewhere',
        });
        const eventCount = await fixture.runtime.client.execute({
            sql: 'SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?',
            args: [fixture.sessionId],
        });
        expect(Number(eventCount.rows[0]?.['count'])).toBe(2);
        expect((await fixture.store.getEvents(fixture.sessionId)).at(-1)).toMatchObject({
            type: 'run.started',
            run: { runId: 'replacement-run' },
        });
        await fixture.host.close();
        await expect(client.stop(acquired.token)).rejects.toBeInstanceOf(SessionOwnerControlClientError);
        await fixture.close(false);
    });
});
