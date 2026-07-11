import type { LocalLibsqlWriteTarget } from '../db/local-libsql-db.js';
import type { SessionControlLease } from './session-control-lease.js';
import {
    completeSessionControlOperation,
    createSessionControlOperation,
    type SessionControlOperationTimer,
    startSessionControlOperationDeadline,
    timeoutSessionControlOperation,
} from './session-control-operation.js';

export type SessionChildSpawnBarrier = {
    readonly release: () => Promise<void>;
};

export async function acquireSessionChildSpawnBarrier(input: {
    readonly runtime: LocalLibsqlWriteTarget;
    readonly lease: SessionControlLease;
    readonly requestId: string;
    readonly operationId: string;
    readonly timeoutMs: number;
    readonly releaseState: () => Promise<void>;
    readonly onReleased?: () => void;
    readonly now?: () => Date;
    readonly monotonicNow?: () => number;
    readonly schedule?: (callback: () => void | Promise<void>, delayMs: number) => unknown;
    readonly cancel?: (timer: unknown) => void;
}): Promise<SessionChildSpawnBarrier> {
    const now = input.now?.() ?? new Date();
    const deadlineWallMs = now.getTime() + input.timeoutMs;
    await createSessionControlOperation({
        runtime: input.runtime,
        lease: input.lease,
        operationId: input.operationId,
        barrierKind: 'child_spawn_only',
        deadlineWallMs,
        capturedHandleIds: [],
        nowWallMs: now.getTime(),
    });
    let released = false;
    let timer: SessionControlOperationTimer | undefined;
    const releaseState = async (): Promise<void> => {
        if (released) return;
        released = true;
        timer?.stop();
        await input.releaseState();
        input.onReleased?.();
    };
    const timeout = async (): Promise<void> => {
        if (released) return;
        const nowWallMs = Date.now();
        await timeoutSessionControlOperation({
            runtime: input.runtime,
            lease: input.lease,
            operationId: input.operationId,
            receipt: {
                outcome: 'failed',
                requestId: input.requestId,
                operationId: input.operationId,
                errorCode: 'stop_timeout',
            },
            barrierReleasedAt: nowWallMs,
            nowWallMs,
            releaseBarrier: releaseState,
        });
    };
    timer = startSessionControlOperationDeadline({
        deadlineWallMs,
        nowWallMs: now.getTime(),
        onDeadline: timeout,
        ...(input.monotonicNow !== undefined ? { monotonicNow: input.monotonicNow } : {}),
        ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
        ...(input.cancel !== undefined ? { cancel: input.cancel } : {}),
    });
    return {
        release: async () => {
            if (released) return;
            const releasedAt = Date.now();
            await completeSessionControlOperation({
                runtime: input.runtime,
                lease: input.lease,
                operationId: input.operationId,
                status: 'completed',
                receipt: {
                    outcome: 'barrier_released',
                    requestId: input.requestId,
                    operationId: input.operationId,
                },
                barrierReleasedAt: releasedAt,
                nowWallMs: releasedAt,
            });
            await releaseState();
        },
    };
}
