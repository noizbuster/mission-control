import { afterEach, describe, expect, it } from 'vitest';
import {
    acquireSessionControlLease,
    expireSessionControlLease,
    readSessionControlLease,
} from './session-control-lease';
import { readSessionControlOperation, settleSessionControlOperationHandle } from './session-control-operation';
import { SessionOwnerControlClientError } from './session-owner-control-client';
import {
    cleanupSessionOwnerControlFixtures,
    createSessionOwnerControlFixture as createFixture,
} from './session-owner-control-test-support';
import { createHash } from 'node:crypto';

afterEach(cleanupSessionOwnerControlFixtures);

describe.runIf(process.platform !== 'win32')('replacement-epoch owner IPC', () => {
    it('persists an unstarted release receipt and terminal timestamps before token eviction', async () => {
        // Given
        const fixture = await createFixture('ipc-explicit-release-order');
        const client = await fixture.client();
        const acquired = await client.acquire({
            sessionId: fixture.sessionId,
            requestId: 'request-explicit-release-order',
            operationId: 'operation-explicit-release-order',
            kind: 'exact_session_stop',
            timeoutMs: 2_000,
        });

        // When
        const released = await client.release(acquired.token);
        const operation = await readSessionControlOperation(
            fixture.runtime,
            fixture.dbIdentity,
            fixture.sessionId,
            'operation-explicit-release-order',
        );

        // Then
        expect(released).toEqual({ released: true });
        expect(operation).toMatchObject({
            status: 'completed',
            receipt: { outcome: 'barrier_released' },
            barrierReleasedAt: expect.any(Number),
            terminalAt: expect.any(Number),
        });
        await expect(client.stop(acquired.token)).rejects.toBeInstanceOf(SessionOwnerControlClientError);
        await fixture.close();
    });

    it('terminalizes the acquired operation before release after a replacement epoch', async () => {
        // Given
        const fixture = await createFixture('ipc-fence-terminalization');
        await fixture.host.attachEntity({
            sessionId: fixture.sessionId,
            kind: 'run',
            entityId: 'replacement-sensitive-run',
            handles: [
                {
                    kind: 'provider',
                    handleId: 'provider:replacement-sensitive-run',
                    abort: () => undefined,
                },
            ],
        });
        const client = await fixture.client();
        const acquired = await client.acquire({
            sessionId: fixture.sessionId,
            requestId: 'request-fence-terminalization',
            operationId: 'operation-fence-terminalization',
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

        // When
        const receipt = await client.stop(acquired.token);
        const operationBeforeRelease = await readSessionControlOperation(
            fixture.runtime,
            fixture.dbIdentity,
            fixture.sessionId,
            'operation-fence-terminalization',
        );
        const released = await client.release(acquired.token);
        const operationAfterRelease = await readSessionControlOperation(
            fixture.runtime,
            fixture.dbIdentity,
            fixture.sessionId,
            'operation-fence-terminalization',
        );
        const staleSettlement = await settleSessionControlOperationHandle({
            runtime: fixture.runtime,
            lease: oldLease,
            operationId: 'operation-fence-terminalization',
            handleKind: 'provider',
            handleId: 'provider:replacement-sensitive-run',
            attemptedEventType: 'llm.turn.completed',
            nowWallMs: Date.now(),
            metadata: { status: 'completed' },
            write: (database) =>
                database
                    .execute({
                        sql: "UPDATE sessions SET status = 'idle' WHERE session_id = ?",
                        args: [fixture.sessionId],
                    })
                    .then(() => undefined),
        });
        const session = await fixture.runtime.client.execute({
            sql: 'SELECT status FROM sessions WHERE session_id = ?',
            args: [fixture.sessionId],
        });

        // Then
        expect(receipt).toMatchObject({ outcome: 'failed', errorCode: 'session_owned_elsewhere' });
        expect(operationBeforeRelease).toMatchObject({
            status: 'failed',
            barrierReleasedAt: expect.any(Number),
            terminalAt: expect.any(Number),
        });
        expect(operationBeforeRelease?.receipt).toEqual(receipt);
        expect(released).toEqual({ released: true });
        expect(operationAfterRelease).toEqual(operationBeforeRelease);
        expect(staleSettlement).toEqual({ accepted: false, allSettled: false });
        expect(session.rows[0]).toMatchObject({ status: 'running' });
        expect((await fixture.store.getEvents(fixture.sessionId)).at(-1)).toMatchObject({
            type: 'run.started',
            run: { runId: 'replacement-run' },
        });
        await expect(client.stop(acquired.token)).rejects.toBeInstanceOf(SessionOwnerControlClientError);
        await fixture.close();
    });
});
