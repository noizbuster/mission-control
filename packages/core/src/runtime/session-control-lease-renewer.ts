export const SESSION_CONTROL_RENEW_INTERVAL_MS = 5_000;
export const SESSION_CONTROL_TRANSIENT_RENEW_RETRY_MS = 1_000;
export const SESSION_CONTROL_MAX_TRANSIENT_RENEW_ERRORS = 2;

type ScheduledCallback = () => void | Promise<void>;

type LeaseRenewerOptions = {
    readonly monotonicNow?: () => number;
    readonly schedule?: (callback: ScheduledCallback, delayMs: number) => unknown;
    readonly cancel?: (timer: unknown) => void;
    readonly intervalMs?: number;
    readonly transientErrorRetryMs?: number;
    readonly maxTransientErrors?: number;
};

export type SessionControlLeaseRenewer = {
    readonly stop: () => void;
};

export function startSessionControlLeaseRenewer(
    input: {
        readonly renew: () => Promise<boolean>;
        readonly onFenced: () => void | Promise<void>;
    } & LeaseRenewerOptions,
): SessionControlLeaseRenewer {
    const monotonicNow = input.monotonicNow ?? (() => performance.now());
    const schedule = input.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    const cancel =
        input.cancel ??
        ((timer: unknown) => {
            if (typeof timer === 'object' && timer !== null) clearTimeout(timer as NodeJS.Timeout);
        });
    const intervalMs = input.intervalMs ?? SESSION_CONTROL_RENEW_INTERVAL_MS;
    const transientErrorRetryMs = input.transientErrorRetryMs ?? SESSION_CONTROL_TRANSIENT_RENEW_RETRY_MS;
    const maxTransientErrors = input.maxTransientErrors ?? SESSION_CONTROL_MAX_TRANSIENT_RENEW_ERRORS;
    let nextRenewalAt = monotonicNow() + intervalMs;
    let transientErrors = 0;
    let timer: unknown;
    let stopped = false;

    const queueAt = (targetMs: number): void => {
        timer = schedule(tick, Math.max(0, targetMs - monotonicNow()));
    };
    const fence = async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        // Fencing is best-effort teardown: the lease is already considered lost at this
        // point, so a rejection from onFenced must never escape `tick`. `tick` is invoked
        // fire-and-forget by the scheduler (setTimeout), so any escaping rejection would
        // become an unhandled rejection and terminate the host process. Mirrors the host's
        // own `void this.fenceEntry(entry).catch(() => undefined)` teardown pattern.
        await Promise.resolve(input.onFenced()).catch(() => undefined);
    };
    const tick = async (): Promise<void> => {
        if (stopped) return;
        try {
            if (!(await input.renew())) {
                await fence();
                return;
            }
        } catch {
            transientErrors += 1;
            if (transientErrors > maxTransientErrors) {
                await fence();
                return;
            }
            queueAt(monotonicNow() + transientErrorRetryMs);
            return;
        }
        transientErrors = 0;
        nextRenewalAt = Math.max(nextRenewalAt + intervalMs, monotonicNow() + intervalMs);
        queueAt(nextRenewalAt);
    };
    queueAt(nextRenewalAt);

    return {
        stop: () => {
            if (stopped) return;
            stopped = true;
            cancel(timer);
        },
    };
}
