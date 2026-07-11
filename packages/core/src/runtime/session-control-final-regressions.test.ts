import { SESSION_OWNER_CONTROL_PROTOCOL_VERSION } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { readSessionControlOperation } from './session-control-operation.js';
import { readSessionControlRegistry } from './session-control-registry-file.js';
import { encodeSessionOwnerControlFrame } from './session-owner-control-framing.js';
import {
    cleanupSessionOwnerControlFixtures,
    createSessionOwnerControlFixture as createFixture,
} from './session-owner-control-test-support.js';
import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';

afterEach(cleanupSessionOwnerControlFixtures);

describe.runIf(process.platform !== 'win32')('final session-control regressions', () => {
    it('durably fails an unexpected exact-stop error before releasing its barrier', async () => {
        // Given
        const fixture = await createFixture('unexpected-stop-failure', true);
        await fixture.host.attachEntity({
            sessionId: fixture.sessionId,
            kind: 'run',
            entityId: 'throwing-run',
            handles: [
                {
                    kind: 'provider',
                    handleId: 'provider:throwing-run',
                    abort: () => {
                        throw new Error('injected abort failure');
                    },
                },
            ],
        });
        const client = await fixture.client();
        const acquired = await client.acquire({
            sessionId: fixture.sessionId,
            requestId: 'request-unexpected-failure',
            operationId: 'operation-unexpected-failure',
            kind: 'exact_session_stop',
            timeoutMs: 2_000,
        });

        // When
        const stopResult = await client.stop(acquired.token).then(
            (receipt) => ({ kind: 'receipt' as const, receipt }),
            (error: unknown) => ({ kind: 'error' as const, error }),
        );

        // Then
        const operation = await readSessionControlOperation(
            fixture.runtime,
            fixture.dbIdentity,
            fixture.sessionId,
            'operation-unexpected-failure',
        );
        expect(operation).toMatchObject({
            status: 'failed',
            receipt: { outcome: 'failed', errorCode: 'owner_unreachable' },
            barrierReleasedAt: expect.any(Number),
            terminalAt: expect.any(Number),
        });
        expect(stopResult).toMatchObject({
            kind: 'receipt',
            receipt: { outcome: 'failed', errorCode: 'owner_unreachable' },
        });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
        await fixture.close();
    });

    it('evicts a deadline-released token after its durable timeout classification', async () => {
        // Given
        let deadlineCallback: (() => void | Promise<void>) | undefined;
        const fixture = await createFixture('deadline-token-eviction', true, {
            now: () => new Date(1_000),
            monotonicNow: () => 100,
            schedule: (callback) => {
                deadlineCallback = callback;
                return callback;
            },
            cancel: () => undefined,
        });
        const client = await fixture.client();
        const acquired = await client.acquire({
            sessionId: fixture.sessionId,
            requestId: 'request-deadline-eviction',
            operationId: 'operation-deadline-eviction',
            kind: 'exact_session_stop',
            timeoutMs: 10,
        });

        // When
        await deadlineCallback?.();

        // Then
        expect(
            await readSessionControlOperation(
                fixture.runtime,
                fixture.dbIdentity,
                fixture.sessionId,
                'operation-deadline-eviction',
            ),
        ).toMatchObject({
            status: 'timed_out',
            receipt: { outcome: 'failed', errorCode: 'stop_timeout' },
            barrierReleasedAt: expect.any(Number),
            terminalAt: expect.any(Number),
        });
        await expect(client.stop(acquired.token)).rejects.toMatchObject({ code: 'token_invalid' });
        const retry = await client.acquire({
            sessionId: fixture.sessionId,
            requestId: 'request-deadline-retry',
            operationId: 'operation-deadline-retry',
            kind: 'exact_session_stop',
            timeoutMs: 100,
        });
        await expect(client.release(retry.token)).resolves.toEqual({ released: true });
        await fixture.close();
    });

    it('evicts a child-spawn-only token when its deadline releases the barrier', async () => {
        // Given
        let deadlineCallback: (() => void | Promise<void>) | undefined;
        const fixture = await createFixture('child-spawn-token-eviction', true, {
            now: () => new Date(1_000),
            monotonicNow: () => 100,
            schedule: (callback) => {
                deadlineCallback = callback;
                return callback;
            },
            cancel: () => undefined,
        });
        const client = await fixture.client();
        const acquired = await client.acquire({
            sessionId: fixture.sessionId,
            requestId: 'request-child-spawn-eviction',
            operationId: 'operation-child-spawn-eviction',
            kind: 'exact_session_stop',
            barrierKind: 'child_spawn_only',
            timeoutMs: 10,
        });

        // When
        await deadlineCallback?.();

        // Then
        expect(fixture.host.classify(fixture.sessionId)).toMatchObject({ kind: 'owned' });
        expect(
            await readSessionControlOperation(
                fixture.runtime,
                fixture.dbIdentity,
                fixture.sessionId,
                'operation-child-spawn-eviction',
            ),
        ).toMatchObject({ status: 'timed_out', barrierReleasedAt: expect.any(Number) });
        await expect(client.release(acquired.token)).rejects.toMatchObject({ code: 'token_invalid' });
        await fixture.close();
    });

    it('does not wedge release when a stop client disconnects before its response flushes', async () => {
        // Given
        const fixture = await createFixture('disconnect-response-release', true);
        const abortStarted = deferred<void>();
        const settlement = deferred<void>();
        await fixture.host.attachEntity({
            sessionId: fixture.sessionId,
            kind: 'run',
            entityId: 'disconnect-run',
            handles: [
                {
                    kind: 'provider',
                    handleId: 'provider:disconnect-run',
                    abort: () => abortStarted.resolve(),
                    settled: settlement.promise,
                },
            ],
        });
        const client = await fixture.client();
        const acquired = await client.acquire({
            sessionId: fixture.sessionId,
            requestId: 'request-disconnect',
            operationId: 'operation-disconnect',
            kind: 'exact_session_stop',
            timeoutMs: 100,
        });
        const paths = await fixture.paths();
        const registry = await readSessionControlRegistry(paths.registryPath);
        const socket = await authenticatedSocket(registry);
        socket.write(
            encodeSessionOwnerControlFrame({
                version: SESSION_OWNER_CONTROL_PROTOCOL_VERSION,
                id: randomUUID(),
                method: 'session.stop',
                params: { token: acquired.token },
            }),
        );
        await abortStarted.promise;

        // When
        socket.destroy();
        settlement.resolve();

        // Then
        await expect(client.release(acquired.token)).resolves.toEqual({ released: true });
        expect(
            await readSessionControlOperation(
                fixture.runtime,
                fixture.dbIdentity,
                fixture.sessionId,
                'operation-disconnect',
            ),
        ).toMatchObject({
            status: 'completed',
            receipt: { outcome: 'already_idle' },
            barrierReleasedAt: expect.any(Number),
            terminalAt: expect.any(Number),
        });
        await fixture.close();
    });
});

async function authenticatedSocket(registry: Awaited<ReturnType<typeof readSessionControlRegistry>>): Promise<Socket> {
    const socket = createConnection(registry.endpoint);
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
    });
    const authenticated = new Promise<void>((resolve, reject) => {
        let buffered = Buffer.alloc(0);
        const onData = (chunk: Buffer): void => {
            buffered = Buffer.concat([buffered, chunk]);
            const newline = buffered.indexOf(0x0a);
            if (newline < 0) return;
            socket.removeListener('data', onData);
            if (buffered.subarray(0, newline).toString('utf8') === '{"ok":true}') resolve();
            else reject(new Error('owner authentication failed'));
        };
        socket.on('data', onData);
    });
    socket.write(
        encodeSessionOwnerControlFrame({
            nonce: registry.nonce,
            owner_id: registry.owner_id,
            epoch: registry.epoch,
        }),
    );
    await authenticated;
    return socket;
}

function deferred<T>(): {
    readonly promise: Promise<T>;
    readonly resolve: (value: T | PromiseLike<T>) => void;
    readonly reject: (reason?: unknown) => void;
} {
    let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
    let reject: (reason?: unknown) => void = () => undefined;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}
