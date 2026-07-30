import { and, eq, gt, inArray, lte, notExists, or, sql } from 'drizzle-orm';
import { drizzleFromClient } from '../db/drizzle-client';
import type { LocalLibsqlWriteTarget } from '../db/local-libsql-db';
import { sessionControlLateSettlements, sessionControlLeases, sessionControlOperations } from '../db/schema';
import { runSessionControlOperationImmediate } from './session-control-operation-sql';
import {
    SESSION_CONTROL_GC_INTERVAL_MS,
    SESSION_CONTROL_LATE_SETTLEMENT_RETENTION_MS,
} from './session-control-operation-types';

type ScheduledCallback = () => void | Promise<void>;

export type SessionControlOperationTimer = {
    readonly stop: () => void;
    readonly drain: () => Promise<void>;
};

export async function gcSessionControlOperations(input: {
    readonly runtime: LocalLibsqlWriteTarget;
    readonly nowWallMs: number;
}): Promise<{ readonly operations: number; readonly lateSettlements: number }> {
    return runSessionControlOperationImmediate(input.runtime, async (client) => {
        const db = drizzleFromClient(client);
        const operationAlias = sessionControlOperations;
        const leaseAlias = sessionControlLeases;
        const deletedOperations = await db
            .delete(operationAlias)
            .where(
                and(
                    lte(operationAlias.retentionUntil, input.nowWallMs),
                    or(
                        inArray(operationAlias.status, ['completed', 'failed', 'timed_out']),
                        notExists(
                            db
                                .select({ one: sql`1` })
                                .from(leaseAlias)
                                .where(
                                    and(
                                        eq(leaseAlias.dbIdentity, operationAlias.dbIdentity),
                                        eq(leaseAlias.sessionId, operationAlias.sessionId),
                                        eq(leaseAlias.ownerId, operationAlias.ownerId),
                                        eq(leaseAlias.epoch, operationAlias.ownerEpoch),
                                        gt(leaseAlias.expiresWallMs, input.nowWallMs),
                                    ),
                                ),
                        ),
                    ),
                ),
            )
            .returning({ operationId: operationAlias.operationId });
        const deletedLate = await db
            .delete(sessionControlLateSettlements)
            .where(lte(sessionControlLateSettlements.observedAt, input.nowWallMs - SESSION_CONTROL_LATE_SETTLEMENT_RETENTION_MS))
            .returning({ lateId: sessionControlLateSettlements.lateId });
        return { operations: deletedOperations.length, lateSettlements: deletedLate.length };
    });
}

export async function startSessionControlOperationGc(input: {
    readonly runtime: LocalLibsqlWriteTarget;
    readonly nowWallMs?: () => number;
    readonly schedule?: (callback: ScheduledCallback, delayMs: number) => unknown;
    readonly cancel?: (timer: unknown) => void;
    readonly intervalMs?: number;
}): Promise<SessionControlOperationTimer> {
    const nowWallMs = input.nowWallMs ?? (() => Date.now());
    const schedule = input.schedule ?? scheduleUnreferencedTimeout;
    const cancel = input.cancel ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    const intervalMs = input.intervalMs ?? SESSION_CONTROL_GC_INTERVAL_MS;
    let timer: unknown;
    let stopped = false;
    let inFlight: Promise<void> | undefined;
    const tick = (): Promise<void> => {
        if (stopped) return Promise.resolve();
        const execution = gcSessionControlOperations({ runtime: input.runtime, nowWallMs: nowWallMs() })
            .then(() => undefined)
            .finally(() => {
                if (inFlight === execution) inFlight = undefined;
                if (!stopped) timer = schedule(tick, intervalMs);
            });
        inFlight = execution;
        return execution;
    };
    await gcSessionControlOperations({ runtime: input.runtime, nowWallMs: nowWallMs() });
    timer = schedule(tick, intervalMs);
    return {
        stop: () => {
            if (stopped) return;
            stopped = true;
            cancel(timer);
        },
        drain: () => inFlight?.catch(() => undefined) ?? Promise.resolve(),
    };
}

function scheduleUnreferencedTimeout(callback: ScheduledCallback, delayMs: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
}

export function startSessionControlOperationDeadline(input: {
    readonly deadlineWallMs: number;
    readonly nowWallMs: number;
    readonly onDeadline: ScheduledCallback;
    readonly monotonicNow?: () => number;
    readonly schedule?: (callback: ScheduledCallback, delayMs: number) => unknown;
    readonly cancel?: (timer: unknown) => void;
}): SessionControlOperationTimer {
    const monotonicNow = input.monotonicNow ?? (() => performance.now());
    const schedule = input.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    const cancel = input.cancel ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    const target = monotonicNow() + Math.max(0, input.deadlineWallMs - input.nowWallMs);
    let stopped = false;
    const timer = schedule(
        async () => {
            if (stopped) return;
            stopped = true;
            await input.onDeadline();
        },
        Math.max(0, target - monotonicNow()),
    );
    return {
        stop: () => {
            if (stopped) return;
            stopped = true;
            cancel(timer);
        },
        drain: () => Promise.resolve(),
    };
}
