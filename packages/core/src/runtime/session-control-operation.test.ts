import { afterEach, describe, expect, it } from 'vitest';
import { expireSessionControlLease } from './session-control-lease';
import {
    completeSessionControlOperation,
    createSessionControlOperation,
    readSessionControlOperation,
    recoverExpiredSessionControlOperations,
    settleSessionControlOperationHandle,
    startSessionControlOperationDeadline,
    timeoutSessionControlOperation,
} from './session-control-operation';
import {
    acquireOperationTestLease,
    cleanupOperationTestRuntimes,
    createMutationProbe,
    createOperationTestRuntime,
    readMutationProbe,
    TEST_DB_IDENTITY,
    TEST_SESSION_ID,
} from './session-control-operation-test-support';

afterEach(cleanupOperationTestRuntimes);

describe('session control operation store', () => {
    it('creates the exact operation and late-settlement schemas', async () => {
        const runtime = await createOperationTestRuntime();

        const operations = await runtime.client.execute("PRAGMA table_info('session_control_operations')");
        const late = await runtime.client.execute("PRAGMA table_info('session_control_late_settlements')");
        runtime.close();

        expect(columnNames(operations.rows)).toEqual([
            'db_identity',
            'session_id',
            'operation_id',
            'owner_id',
            'owner_epoch',
            'barrier_kind',
            'status',
            'deadline_wall_ms',
            'receipt_json',
            'captured_handle_ids_json',
            'settled_handle_ids_json',
            'barrier_released_at',
            'created_at',
            'terminal_at',
            'retention_until',
        ]);
        expect(primaryKeyColumns(operations.rows)).toEqual(['db_identity', 'session_id', 'operation_id']);
        expect(columnNames(late.rows)).toEqual([
            'late_id',
            'db_identity',
            'session_id',
            'operation_id',
            'owner_epoch',
            'handle_kind',
            'handle_id',
            'attempted_event_type',
            'observed_at',
            'metadata_json',
        ]);
        expect(primaryKeyColumns(late.rows)).toEqual(['late_id']);
    });

    it('accepts a lease-fenced callback, records settlement, and makes terminal status immutable', async () => {
        const runtime = await createOperationTestRuntime();
        const lease = await acquireOperationTestLease(runtime, 'owner-one', 1_000);
        await createMutationProbe(runtime);
        await createSessionControlOperation({
            runtime,
            lease,
            operationId: 'operation-one',
            barrierKind: 'all_mutations',
            deadlineWallMs: 10_000,
            capturedHandleIds: ['tool:one'],
            nowWallMs: 1_100,
        });

        const settlement = await settleSessionControlOperationHandle({
            runtime,
            lease,
            operationId: 'operation-one',
            handleKind: 'tool',
            handleId: 'tool:one',
            attemptedEventType: 'tool.failed',
            nowWallMs: 1_200,
            metadata: { status: 'failed', errorCode: 'operator_aborted', signalAborted: true, elapsedMs: 12 },
            write: (client) =>
                client.execute("INSERT INTO mutation_probe (value) VALUES ('accepted')").then(() => undefined),
        });
        await completeSessionControlOperation({
            runtime,
            lease,
            operationId: 'operation-one',
            status: 'completed',
            receipt: { outcome: 'interrupted' },
            barrierReleasedAt: 1_300,
            nowWallMs: 1_300,
        });

        expect(settlement).toEqual({ accepted: true, allSettled: true });
        expect(await readMutationProbe(runtime)).toEqual([{ value: 'accepted' }]);
        expect(
            await readSessionControlOperation(runtime, TEST_DB_IDENTITY, TEST_SESSION_ID, 'operation-one'),
        ).toMatchObject({
            status: 'completed',
            settledHandleIds: ['tool:one'],
            receipt: { outcome: 'interrupted' },
            retentionUntil: 86_401_300,
        });
        await expect(
            runtime.client.execute(
                "UPDATE session_control_operations SET status = 'failed' WHERE operation_id = 'operation-one'",
            ),
        ).rejects.toThrow(/terminal/u);
        runtime.close();
    });

    it('tombstones timeout with a cached receipt before releasing the barrier', async () => {
        const runtime = await createOperationTestRuntime();
        const lease = await acquireOperationTestLease(runtime, 'owner-one', 1_000);
        await createSessionControlOperation({
            runtime,
            lease,
            operationId: 'operation-timeout',
            barrierKind: 'child_spawn_only',
            deadlineWallMs: 2_000,
            capturedHandleIds: ['shell:one'],
            nowWallMs: 1_100,
        });
        let observedStatusDuringRelease: string | undefined;

        const first = await timeoutSessionControlOperation({
            runtime,
            lease,
            operationId: 'operation-timeout',
            receipt: { outcome: 'failed', errorCode: 'stop_timeout' },
            barrierReleasedAt: 2_001,
            nowWallMs: 2_001,
            releaseBarrier: async () => {
                observedStatusDuringRelease = (
                    await readSessionControlOperation(runtime, TEST_DB_IDENTITY, TEST_SESSION_ID, 'operation-timeout')
                )?.status;
            },
        });
        const replay = await timeoutSessionControlOperation({
            runtime,
            lease,
            operationId: 'operation-timeout',
            receipt: { ignored: true },
            barrierReleasedAt: 2_100,
            nowWallMs: 2_100,
            releaseBarrier: () => {
                throw new Error('cached timeout must not release twice');
            },
        });

        expect(observedStatusDuringRelease).toBe('timed_out');
        expect(first).toEqual({ transitioned: true, receipt: { outcome: 'failed', errorCode: 'stop_timeout' } });
        expect(replay).toEqual({ transitioned: false, receipt: { outcome: 'failed', errorCode: 'stop_timeout' } });
        runtime.close();
    });

    it('uses a local monotonic deadline while restart recovery uses the persisted wall deadline', async () => {
        let monotonicMs = 50;
        let delayMs = -1;
        let callback: (() => void | Promise<void>) | undefined;
        let fired = false;
        const deadline = startSessionControlOperationDeadline({
            deadlineWallMs: 2_000,
            nowWallMs: 1_000,
            monotonicNow: () => monotonicMs,
            schedule: (scheduled, delay) => {
                callback = scheduled;
                delayMs = delay;
                return scheduled;
            },
            cancel: () => undefined,
            onDeadline: () => {
                fired = true;
            },
        });
        monotonicMs = 1_050;
        await callback?.();
        deadline.stop();

        const runtime = await createOperationTestRuntime();
        const lease = await acquireOperationTestLease(runtime, 'owner-one', 1_000);
        await createSessionControlOperation({
            runtime,
            lease,
            operationId: 'operation-restart',
            barrierKind: 'all_mutations',
            deadlineWallMs: 2_000,
            capturedHandleIds: [],
            nowWallMs: 1_100,
        });
        const recovered = await recoverExpiredSessionControlOperations({ runtime, nowWallMs: 2_001 });

        expect(delayMs).toBe(1_000);
        expect(fired).toBe(true);
        expect(recovered).toEqual(['operation-restart']);
        expect(
            await readSessionControlOperation(runtime, TEST_DB_IDENTITY, TEST_SESSION_ID, 'operation-restart'),
        ).toMatchObject({
            status: 'timed_out',
        });
        runtime.close();
    });

    it('quarantines an old lease callback with no tombstone and never runs its durable write', async () => {
        const runtime = await createOperationTestRuntime();
        const oldLease = await acquireOperationTestLease(runtime, 'owner-old', 1_000);
        await createMutationProbe(runtime);
        await expireSessionControlLease({ runtime, lease: oldLease, nowWallMs: 2_000 });
        await acquireOperationTestLease(runtime, 'owner-new', 2_000);

        const result = await settleSessionControlOperationHandle({
            runtime,
            lease: oldLease,
            operationId: 'missing-operation',
            handleKind: 'provider',
            handleId: 'provider:old',
            attemptedEventType: 'llm.turn.completed',
            nowWallMs: 2_100,
            lateId: 'late-redacted',
            metadata: {
                status: 'completed',
                errorCode: 'provider_aborted',
                signalAborted: true,
                elapsedMs: 99,
                prompt: 'secret prompt',
                args: ['secret'],
                output: 'secret output',
                token: 'secret token',
            },
            write: (client) =>
                client.execute("INSERT INTO mutation_probe (value) VALUES ('stale')").then(() => undefined),
        });
        const late = await runtime.client.execute(
            "SELECT metadata_json FROM session_control_late_settlements WHERE late_id = 'late-redacted'",
        );

        expect(result).toEqual({ accepted: false, allSettled: false });
        expect(await readMutationProbe(runtime)).toEqual([]);
        expect(late.rows).toEqual([
            {
                metadata_json: JSON.stringify({
                    status: 'completed',
                    errorCode: 'provider_aborted',
                    signalAborted: true,
                    elapsedMs: 99,
                }),
            },
        ]);
        runtime.close();
    });

    it('records timed-out handle settlement without writing and switches fully settled retention to 24 hours', async () => {
        const runtime = await createOperationTestRuntime();
        const lease = await acquireOperationTestLease(runtime, 'owner-timeout-late', 1_000);
        await createMutationProbe(runtime);
        await createSessionControlOperation({
            runtime,
            lease,
            operationId: 'operation-timeout-late',
            barrierKind: 'all_mutations',
            deadlineWallMs: 2_000,
            capturedHandleIds: ['shell:late'],
            nowWallMs: 1_100,
        });
        await timeoutSessionControlOperation({
            runtime,
            lease,
            operationId: 'operation-timeout-late',
            receipt: { outcome: 'failed', errorCode: 'stop_timeout' },
            barrierReleasedAt: 2_001,
            nowWallMs: 2_001,
            releaseBarrier: () => undefined,
        });

        const settlement = await settleSessionControlOperationHandle({
            runtime,
            lease,
            operationId: 'operation-timeout-late',
            handleKind: 'shell',
            handleId: 'shell:late',
            attemptedEventType: 'command.failed',
            nowWallMs: 2_100,
            metadata: { status: 'failed', errorCode: 'operator_aborted', signalAborted: true },
            write: (client) =>
                client.execute("INSERT INTO mutation_probe (value) VALUES ('must-not-write')").then(() => undefined),
        });

        expect(settlement).toEqual({ accepted: false, allSettled: true });
        expect(await readMutationProbe(runtime)).toEqual([]);
        expect(
            await readSessionControlOperation(runtime, TEST_DB_IDENTITY, TEST_SESSION_ID, 'operation-timeout-late'),
        ).toMatchObject({
            status: 'timed_out',
            settledHandleIds: ['shell:late'],
            retentionUntil: 2_100 + 24 * 60 * 60 * 1_000,
        });
        runtime.close();
    });

    it('drops arbitrary secret-bearing metadata values while preserving exact safe keys', async () => {
        const runtime = await createOperationTestRuntime();
        const lease = await acquireOperationTestLease(runtime, 'owner-secret-redaction', 1_000);
        await settleSessionControlOperationHandle({
            runtime,
            lease,
            operationId: 'missing-secret-operation',
            handleKind: 'provider',
            handleId: 'provider:secret',
            attemptedEventType: 'llm.error',
            nowWallMs: 1_100,
            lateId: 'late-secret-values',
            metadata: {
                status: 'sk-live-status-secret',
                errorCode: 'sk-live-error-secret',
                signalAborted: true,
                elapsedMs: 7,
            },
        });
        const row = await runtime.client.execute(
            "SELECT metadata_json FROM session_control_late_settlements WHERE late_id = 'late-secret-values'",
        );

        expect(row.rows).toEqual([{ metadata_json: JSON.stringify({ signalAborted: true, elapsedMs: 7 }) }]);
        runtime.close();
    });
});

function columnNames(rows: readonly Record<string, unknown>[]): readonly unknown[] {
    return rows.map((row) => Reflect.get(row, 'name'));
}

function primaryKeyColumns(rows: readonly Record<string, unknown>[]): readonly unknown[] {
    return rows.filter((row) => Number(Reflect.get(row, 'pk')) > 0).map((row) => Reflect.get(row, 'name'));
}
