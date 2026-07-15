import { afterEach, describe, expect, it } from 'vitest';
import { expireSessionControlLease } from './session-control-lease';
import {
    completeSessionControlOperation,
    createSessionControlOperation,
    gcSessionControlOperations,
    readSessionControlOperation,
    SESSION_CONTROL_DEAD_LEASE_RETENTION_MS,
    SESSION_CONTROL_GC_INTERVAL_MS,
    SESSION_CONTROL_LATE_SETTLEMENT_RETENTION_MS,
    SESSION_CONTROL_SETTLED_RETENTION_MS,
    settleSessionControlOperationHandle,
    startSessionControlOperationGc,
} from './session-control-operation';
import {
    acquireOperationTestLease,
    cleanupOperationTestRuntimes,
    createOperationTestRuntime,
    TEST_DB_IDENTITY,
    TEST_SESSION_ID,
} from './session-control-operation-test-support';

afterEach(cleanupOperationTestRuntimes);

describe('session control operation retention and GC', () => {
    it('retains fully settled work for 24 hours and dead-lease work for seven days', async () => {
        const runtime = await createOperationTestRuntime();
        const lease = await acquireOperationTestLease(runtime, 'owner-one', 1_000);
        await createSessionControlOperation({
            runtime,
            lease,
            operationId: 'settled',
            barrierKind: 'all_mutations',
            deadlineWallMs: 10_000,
            capturedHandleIds: [],
            nowWallMs: 1_100,
        });
        await completeSessionControlOperation({
            runtime,
            lease,
            operationId: 'settled',
            status: 'completed',
            receipt: { ok: true },
            barrierReleasedAt: 1_200,
            nowWallMs: 1_200,
        });
        await createSessionControlOperation({
            runtime,
            lease,
            operationId: 'orphaned',
            barrierKind: 'all_mutations',
            deadlineWallMs: 20_000,
            capturedHandleIds: ['job:one'],
            nowWallMs: 1_300,
        });
        await expireSessionControlLease({ runtime, lease, nowWallMs: 2_000 });
        const deadLeaseExpiry = 2_000;

        await gcSessionControlOperations({
            runtime,
            nowWallMs: 1_200 + SESSION_CONTROL_SETTLED_RETENTION_MS - 1,
        });
        expect(await readSessionControlOperation(runtime, TEST_DB_IDENTITY, TEST_SESSION_ID, 'settled')).toBeDefined();
        await gcSessionControlOperations({ runtime, nowWallMs: 1_200 + SESSION_CONTROL_SETTLED_RETENTION_MS });
        expect(
            await readSessionControlOperation(runtime, TEST_DB_IDENTITY, TEST_SESSION_ID, 'settled'),
        ).toBeUndefined();

        await gcSessionControlOperations({
            runtime,
            nowWallMs: deadLeaseExpiry + SESSION_CONTROL_DEAD_LEASE_RETENTION_MS - 1,
        });
        expect(await readSessionControlOperation(runtime, TEST_DB_IDENTITY, TEST_SESSION_ID, 'orphaned')).toBeDefined();
        await gcSessionControlOperations({
            runtime,
            nowWallMs: deadLeaseExpiry + SESSION_CONTROL_DEAD_LEASE_RETENTION_MS,
        });
        expect(
            await readSessionControlOperation(runtime, TEST_DB_IDENTITY, TEST_SESSION_ID, 'orphaned'),
        ).toBeUndefined();
        runtime.close();
    });

    it('retains quarantined callbacks for exactly 30 days', async () => {
        const runtime = await createOperationTestRuntime();
        const lease = await acquireOperationTestLease(runtime, 'owner-old', 1_000);
        await settleSessionControlOperationHandle({
            runtime,
            lease,
            operationId: 'missing',
            handleKind: 'shell',
            handleId: 'shell:late',
            attemptedEventType: 'command.completed',
            nowWallMs: 2_000,
            lateId: 'late-thirty-days',
            metadata: { status: 'completed' },
        });

        await gcSessionControlOperations({
            runtime,
            nowWallMs: 2_000 + SESSION_CONTROL_LATE_SETTLEMENT_RETENTION_MS - 1,
        });
        expect(await lateCount(runtime)).toBe(1);
        await gcSessionControlOperations({
            runtime,
            nowWallMs: 2_000 + SESSION_CONTROL_LATE_SETTLEMENT_RETENTION_MS,
        });
        expect(await lateCount(runtime)).toBe(0);
        runtime.close();
    });

    it('runs GC immediately at startup and schedules it hourly', async () => {
        const runtime = await createOperationTestRuntime();
        let scheduledDelay = 0;
        let scheduled: (() => void | Promise<void>) | undefined;
        let scheduleCount = 0;
        const runner = await startSessionControlOperationGc({
            runtime,
            nowWallMs: () => 123,
            schedule: (callback, delayMs) => {
                scheduled = callback;
                scheduledDelay = delayMs;
                scheduleCount += 1;
                return callback;
            },
            cancel: () => undefined,
        });

        expect(scheduledDelay).toBe(SESSION_CONTROL_GC_INTERVAL_MS);
        expect(scheduleCount).toBe(1);
        await scheduled?.();
        expect(scheduleCount).toBe(2);
        runner.stop();
        runtime.close();
    });
});

async function lateCount(runtime: Awaited<ReturnType<typeof createOperationTestRuntime>>): Promise<number> {
    const result = await runtime.client.execute('SELECT COUNT(*) AS count FROM session_control_late_settlements');
    return Number(Reflect.get(result.rows[0] ?? {}, 'count') ?? 0);
}
