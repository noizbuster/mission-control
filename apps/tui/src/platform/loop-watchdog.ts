/**
 * Always-on event-loop lag probe (ported from ref/omp LoopWatchdog).
 *
 * Each tick is scheduled `intervalMs` ahead of a recorded deadline; a tick that
 * fires `thresholdMs` past its deadline means the loop was blocked that long.
 * The overshoot is logged once on the rising edge (one block ⇒ one line), then
 * quiet while the loop stays blocked. The handle is `unref`'d so the probe never
 * keeps the process alive.
 */

export type LoopWatchdogOptions = {
    /** How far ahead each probe tick is scheduled, in ms. Default 250. */
    readonly intervalMs?: number;
    /** A tick later than this past its deadline counts as a block. Default 250. */
    readonly thresholdMs?: number;
    /** Monotonic clock source; injectable for tests. Default `performance.now`. */
    readonly now?: () => number;
    /** Timer source; injectable for tests. Default `setTimeout`. */
    readonly schedule?: (cb: () => void, ms: number) => LoopWatchdogTimer;
    /** Rising-edge stall reporter; default writes one stderr line. */
    readonly onBlocked?: (info: { readonly blockedMs: number }) => void;
};

export type LoopWatchdogTimer = {
    unref?(): void;
    cancel?(): void;
};

function defaultSchedule(cb: () => void, ms: number): LoopWatchdogTimer {
    const handle = setTimeout(cb, ms);
    const timer: LoopWatchdogTimer = {
        unref: () => {
            handle.unref();
        },
        cancel: () => {
            clearTimeout(handle);
        },
    };
    return timer;
}

function defaultOnBlocked(info: { readonly blockedMs: number }): void {
    try {
        process.stderr.write(`[tui] event loop blocked for ${Math.round(info.blockedMs)}ms\n`);
    } catch {
        // Crash/teardown paths may lose stderr; never throw from the probe.
    }
}

/**
 * Event-loop lag probe. Start from the OpenTUI mount path and stop on unmount so
 * a live interactive session always has stall visibility without keeping Node
 * alive after the TUI exits.
 */
export class LoopWatchdog {
    private readonly intervalMs: number;
    private readonly thresholdMs: number;
    private readonly now: () => number;
    private readonly schedule: (cb: () => void, ms: number) => LoopWatchdogTimer;
    private readonly onBlocked: (info: { readonly blockedMs: number }) => void;
    private expected = 0;
    private wasBlocked = false;
    private running = false;
    /** Bumped by stop(); scheduled ticks no-op when their generation mismatches. */
    private generation = 0;
    private handle: LoopWatchdogTimer | undefined;

    constructor(options: LoopWatchdogOptions = {}) {
        this.intervalMs = options.intervalMs ?? 250;
        this.thresholdMs = options.thresholdMs ?? 250;
        this.now = options.now ?? (() => performance.now());
        this.schedule = options.schedule ?? defaultSchedule;
        this.onBlocked = options.onBlocked ?? defaultOnBlocked;
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.wasBlocked = false;
        this.armTick();
    }

    stop(): void {
        if (!this.running) return;
        this.running = false;
        this.generation += 1;
        const handle = this.handle;
        this.handle = undefined;
        handle?.cancel?.();
    }

    private armTick(): void {
        if (!this.running) return;
        const generation = this.generation;
        this.expected = this.now() + this.intervalMs;
        const handle = this.schedule(() => {
            this.tick(generation);
        }, this.intervalMs);
        handle.unref?.();
        this.handle = handle;
    }

    private tick(generation: number): void {
        if (!this.running || generation !== this.generation) return;
        const overshoot = this.now() - this.expected;
        if (overshoot > this.thresholdMs) {
            if (!this.wasBlocked) {
                this.wasBlocked = true;
                this.onBlocked({ blockedMs: overshoot });
            }
        } else {
            this.wasBlocked = false;
        }
        this.armTick();
    }
}
