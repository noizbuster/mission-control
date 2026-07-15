import type { LocalLibsqlWriteTarget } from '../db/local-libsql-db';
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
        const operations = await client.execute({
            sql:
                'DELETE FROM session_control_operations AS operation WHERE operation.retention_until <= ? AND (' +
                "operation.status IN ('completed','failed','timed_out') OR NOT EXISTS (" +
                'SELECT 1 FROM session_control_leases AS lease WHERE lease.db_identity = operation.db_identity ' +
                'AND lease.session_id = operation.session_id AND lease.owner_id = operation.owner_id ' +
                'AND lease.epoch = operation.owner_epoch AND lease.expires_wall_ms > ?))',
            args: [input.nowWallMs, input.nowWallMs],
        });
        const lateSettlements = await client.execute({
            sql: 'DELETE FROM session_control_late_settlements WHERE observed_at <= ?',
            args: [input.nowWallMs - SESSION_CONTROL_LATE_SETTLEMENT_RETENTION_MS],
        });
        return { operations: operations.rowsAffected, lateSettlements: lateSettlements.rowsAffected };
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
