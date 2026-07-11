export const SESSION_CONTROL_RENEW_INTERVAL_MS = 5_000;

type ScheduledCallback = () => void | Promise<void>;

export type SessionControlLeaseRenewer = {
    readonly stop: () => void;
};

export function startSessionControlLeaseRenewer(input: {
    readonly renew: () => Promise<boolean>;
    readonly onFenced: () => void | Promise<void>;
    readonly monotonicNow?: () => number;
    readonly schedule?: (callback: ScheduledCallback, delayMs: number) => unknown;
    readonly cancel?: (timer: unknown) => void;
    readonly intervalMs?: number;
}): SessionControlLeaseRenewer {
    const monotonicNow = input.monotonicNow ?? (() => performance.now());
    const schedule = input.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    const cancel = input.cancel ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    const intervalMs = input.intervalMs ?? SESSION_CONTROL_RENEW_INTERVAL_MS;
    let nextRenewalAt = monotonicNow() + intervalMs;
    let timer: unknown;
    let stopped = false;

    const queue = (): void => {
        timer = schedule(tick, Math.max(0, nextRenewalAt - monotonicNow()));
    };
    const tick = async (): Promise<void> => {
        if (stopped) return;
        let renewed = false;
        try {
            renewed = await input.renew();
        } catch {}
        if (!renewed) {
            stopped = true;
            await input.onFenced();
            return;
        }
        if (stopped) return;
        nextRenewalAt += intervalMs;
        queue();
    };
    queue();

    return {
        stop: () => {
            if (stopped) return;
            stopped = true;
            cancel(timer);
        },
    };
}
