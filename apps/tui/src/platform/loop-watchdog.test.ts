import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoopWatchdog, type LoopWatchdogTimer } from './loop-watchdog';

type MockFn = {
    (...args: unknown[]): unknown;
    mock: { readonly calls: readonly unknown[][] };
};

type WatchdogHarness = {
    readonly wd: LoopWatchdog;
    readonly onBlocked: MockFn;
    readonly unrefs: readonly MockFn[];
    readonly cancels: readonly MockFn[];
    setNow(value: number): void;
    fireTick(): void;
};

function harness(options: { readonly intervalMs?: number; readonly thresholdMs?: number } = {}): WatchdogHarness {
    let nowValue = 0;
    const callbacks: Array<() => void> = [];
    const cancels: MockFn[] = [];
    const unrefs: MockFn[] = [];
    const onBlocked = vi.fn() as unknown as MockFn;
    const schedule = (cb: () => void, _ms: number): LoopWatchdogTimer => {
        callbacks.push(cb);
        const cancel = vi.fn() as unknown as MockFn;
        const unref = vi.fn() as unknown as MockFn;
        cancels.push(cancel);
        unrefs.push(unref);
        return {
            cancel: () => {
                cancel();
            },
            unref: () => {
                unref();
            },
        };
    };
    const wd = new LoopWatchdog({
        now: () => nowValue,
        schedule,
        onBlocked: (info) => {
            onBlocked(info);
        },
        intervalMs: options.intervalMs ?? 250,
        thresholdMs: options.thresholdMs ?? 250,
    });
    return {
        wd,
        onBlocked,
        unrefs,
        cancels,
        setNow(value: number): void {
            nowValue = value;
        },
        fireTick(): void {
            const cb = callbacks.shift();
            if (cb === undefined) throw new Error('no armed tick');
            cb();
        },
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('LoopWatchdog', () => {
    it('logs once on the rising edge when a tick runs late', () => {
        const { wd, onBlocked, setNow, fireTick, unrefs } = harness();
        wd.start();
        expect(unrefs[0]?.mock.calls.length).toBe(1);

        setNow(600); // expected 250, overshoot 350 > threshold 250
        fireTick();
        expect(onBlocked.mock.calls).toEqual([[{ blockedMs: 350 }]]);

        setNow(900); // still blocked
        fireTick();
        expect(onBlocked.mock.calls).toHaveLength(1);

        setNow(1000); // recovered (overshoot <= threshold)
        fireTick();
        // After recovery, next deadline is now+interval (1000+250=1250). Need
        // overshoot > threshold: fire at > 1500.
        setNow(1600);
        fireTick();
        expect(onBlocked.mock.calls).toHaveLength(2);
        wd.stop();
    });

    it('cancels the armed timer on stop', () => {
        const { wd, onBlocked, cancels } = harness();
        wd.start();
        wd.stop();
        expect(cancels[0]?.mock.calls.length).toBe(1);

        wd.start();
        wd.stop();
        expect(onBlocked.mock.calls).toHaveLength(0);
    });
});
