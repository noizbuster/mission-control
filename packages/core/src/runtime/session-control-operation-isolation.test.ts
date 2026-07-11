import { afterEach, describe, expect, it } from 'vitest';
import { openLocalLibsqlDb } from '../db/local-libsql-db.js';
import { expireSessionControlLease } from './session-control-lease.js';
import {
    createSessionControlOperation,
    readSessionControlOperation,
    recoverExpiredSessionControlOperations,
    settleSessionControlOperationHandle,
} from './session-control-operation.js';
import {
    acquireOperationTestLease,
    cleanupOperationTestRuntimes,
    createMutationProbe,
    createOperationTestRuntime,
    readMutationProbe,
    TEST_DB_IDENTITY,
    TEST_SESSION_ID,
} from './session-control-operation-test-support.js';

afterEach(cleanupOperationTestRuntimes);

describe('session control operation restart and isolation', () => {
    it('recovers an expired active operation after the database is closed and reopened', async () => {
        const first = await createOperationTestRuntime();
        const lease = await acquireOperationTestLease(first, 'owner-restart', 1_000);
        await createSessionControlOperation({
            runtime: first,
            lease,
            operationId: 'restart-operation',
            barrierKind: 'all_mutations',
            deadlineWallMs: 2_000,
            capturedHandleIds: [],
            nowWallMs: 1_100,
        });
        const url = first.url;
        first.close();

        const reopened = await openLocalLibsqlDb({ url });
        const recovered = await recoverExpiredSessionControlOperations({ runtime: reopened, nowWallMs: 2_001 });

        expect(recovered).toEqual(['restart-operation']);
        expect(
            await readSessionControlOperation(reopened, TEST_DB_IDENTITY, TEST_SESSION_ID, 'restart-operation'),
        ).toMatchObject({ status: 'timed_out', receipt: { outcome: 'failed', errorCode: 'stop_timeout' } });
        reopened.close();
    });

    it('quarantines old provider, tool, job, and shell callbacks without mutating a newer operation', async () => {
        const runtime = await createOperationTestRuntime();
        const oldLease = await acquireOperationTestLease(runtime, 'owner-old', 1_000);
        await createMutationProbe(runtime);
        const handles = ['provider:same', 'tool:same', 'job:same', 'shell:same'] as const;
        await createSessionControlOperation({
            runtime,
            lease: oldLease,
            operationId: 'old-operation',
            barrierKind: 'all_mutations',
            deadlineWallMs: 20_000,
            capturedHandleIds: handles,
            nowWallMs: 1_100,
        });
        await expireSessionControlLease({ runtime, lease: oldLease, nowWallMs: 2_000 });
        const newLease = await acquireOperationTestLease(runtime, 'owner-new', 2_000);
        await createSessionControlOperation({
            runtime,
            lease: newLease,
            operationId: 'new-operation',
            barrierKind: 'all_mutations',
            deadlineWallMs: 30_000,
            capturedHandleIds: handles,
            nowWallMs: 2_100,
        });

        const stale = await Promise.all(
            handles.map((handleId, index) =>
                settleSessionControlOperationHandle({
                    runtime,
                    lease: oldLease,
                    operationId: 'old-operation',
                    handleKind: handleId.slice(0, handleId.indexOf(':')),
                    handleId,
                    attemptedEventType: attemptedEventTypes[index] ?? 'unknown.completed',
                    nowWallMs: 2_200 + index,
                    lateId: `late-old-${index}`,
                    metadata: { status: 'completed', signalAborted: true },
                    write: (client) =>
                        client
                            .execute({ sql: 'INSERT INTO mutation_probe (value) VALUES (?)', args: [handleId] })
                            .then(() => undefined),
                }),
            ),
        );
        const late = await runtime.client.execute(
            "SELECT handle_kind FROM session_control_late_settlements WHERE operation_id = 'old-operation' ORDER BY handle_kind",
        );

        expect(stale).toEqual(handles.map(() => ({ accepted: false, allSettled: false })));
        expect(await readMutationProbe(runtime)).toEqual([]);
        expect(late.rows).toEqual([
            { handle_kind: 'job' },
            { handle_kind: 'provider' },
            { handle_kind: 'shell' },
            { handle_kind: 'tool' },
        ]);
        expect(
            await readSessionControlOperation(runtime, TEST_DB_IDENTITY, TEST_SESSION_ID, 'new-operation'),
        ).toMatchObject({
            status: 'active',
            settledHandleIds: [],
        });
        runtime.close();
    });
});

const attemptedEventTypes = ['llm.turn.completed', 'tool.completed', 'job.completed', 'command.completed'] as const;
