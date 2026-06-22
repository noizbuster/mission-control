/**
 * Per-key serialized drain-lane state machine (Task 1.5).
 *
 * Ports the drain-lane concept from OpenCode's Effect-based SessionRunCoordinator into
 * plain TypeScript with native Promise / AbortController. One lane per key; different keys
 * run concurrently. `run` dominates `wake` via {@linkcode coalesceDemand}.
 */

export type CoordinatorDemand = { readonly tag: 'run' } | { readonly tag: 'wake'; readonly seq: number | undefined };

export type DrainMode = 'run' | 'wake';

export type CoordinatorExit<A> =
    | { readonly status: 'success'; readonly value: A }
    | { readonly status: 'failure'; readonly error: unknown };

export type DrainFn<A> = (key: string, mode: DrainMode, signal: AbortSignal) => Promise<A>;

/** Combine follow-up demand: runs dominate; wakes retain the newest admission sequence. */
export function coalesceDemand(left: CoordinatorDemand | undefined, right: CoordinatorDemand): CoordinatorDemand {
    if (left?.tag === 'run' || right.tag === 'run') return { tag: 'run' };
    const leftSeq = left?.tag === 'wake' ? left.seq : undefined;
    const rightSeq = right.tag === 'wake' ? right.seq : undefined;
    return { tag: 'wake', seq: maxSeq(leftSeq, rightSeq) };
}

function maxSeq(left: number | undefined, right: number | undefined): number | undefined {
    if (left === undefined) return right;
    if (right === undefined) return left;
    return Math.max(left, right);
}

interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
}

function makeDeferred<T>(): Deferred<T> {
    const ref: {
        resolve: ((value: T) => void) | undefined;
        reject: ((error: unknown) => void) | undefined;
    } = { resolve: undefined, reject: undefined };
    const promise = new Promise<T>((resolve, reject) => {
        ref.resolve = resolve;
        ref.reject = reject;
    });
    return {
        promise,
        resolve: (value: T) => {
            const fn = ref.resolve;
            if (fn !== undefined) fn(value);
        },
        reject: (error: unknown) => {
            const fn = ref.reject;
            if (fn !== undefined) fn(error);
        },
    };
}

interface Lane<A> {
    current: CoordinatorDemand;
    runFn: DrainFn<A> | undefined;
    pending: CoordinatorDemand | undefined;
    pendingRunFn: DrainFn<A> | undefined;
    stopping: boolean;
    interruptSeq: number | undefined;
    done: Deferred<A>;
    settled: Deferred<CoordinatorExit<A>>;
    explicitWaiter: Deferred<A> | undefined;
    controller: AbortController | undefined;
}

export class RunCoordinatorV2<A = void> {
    private readonly active = new Map<string, Lane<A>>();
    private readonly drain: DrainFn<A>;
    private readonly onFailure: ((key: string, error: unknown) => void) | undefined;

    constructor(options: {
        drain: DrainFn<A>;
        onFailure?: (key: string, error: unknown) => void;
    }) {
        this.drain = options.drain;
        this.onFailure = options.onFailure;
    }

    /** Starts or joins one explicit drain generation; returns the drain result. */
    run(key: string, fn?: DrainFn<A>): Promise<A> {
        const lane = this.active.get(key);
        if (lane !== undefined) {
            if (lane.stopping) {
                return lane.settled.promise.then(() => this.run(key, fn));
            }
            if (lane.current.tag === 'wake') {
                lane.pending = coalesceDemand(lane.pending, { tag: 'run' });
                lane.pendingRunFn = fn;
                if (lane.explicitWaiter === undefined) {
                    lane.explicitWaiter = makeDeferred<A>();
                }
                return lane.explicitWaiter.promise;
            }
            return lane.done.promise;
        }
        const next = this.makeLane({ tag: 'run' }, fn);
        this.active.set(key, next);
        void this.startDrain(key, next);
        return next.done.promise;
    }

    /** Coalesces one wake-up after durable work is recorded. */
    wake(key: string, seq?: number): void {
        const lane = this.active.get(key);
        if (lane !== undefined) {
            lane.pending = coalesceDemand(lane.pending, { tag: 'wake', seq });
            return;
        }
        const next = this.makeLane({ tag: 'wake', seq }, undefined);
        this.active.set(key, next);
        void this.startDrain(key, next);
    }

    /** Aborts the active drain and suppresses pending demands at or before the interrupt seq. */
    interrupt(key: string, seq?: number): void {
        const lane = this.active.get(key);
        if (lane === undefined) return;
        lane.stopping = true;
        lane.interruptSeq = seq;
        this.suppressPendingAtOrBefore(lane, seq);
        lane.controller?.abort();
    }

    /** Waits until no active drain for the key. */
    async awaitIdle(key: string): Promise<void> {
        for (;;) {
            const lane = this.active.get(key);
            if (lane === undefined) return;
            await lane.settled.promise;
        }
    }

    private makeLane(demand: CoordinatorDemand, runFn: DrainFn<A> | undefined): Lane<A> {
        return {
            current: demand,
            runFn,
            pending: undefined,
            pendingRunFn: undefined,
            stopping: false,
            interruptSeq: undefined,
            done: makeDeferred<A>(),
            settled: makeDeferred<CoordinatorExit<A>>(),
            explicitWaiter: undefined,
            controller: undefined,
        };
    }

    private async startDrain(key: string, lane: Lane<A>): Promise<void> {
        const controller = new AbortController();
        lane.controller = controller;
        const mode: DrainMode = lane.current.tag;
        const fn = (lane.current.tag === 'run' ? lane.runFn : undefined) ?? this.drain;
        try {
            const value = await fn(key, mode, controller.signal);
            this.settle(key, lane, { status: 'success', value });
        } catch (error) {
            this.settle(key, lane, { status: 'failure', error });
        }
    }

    private settle(key: string, lane: Lane<A>, exit: CoordinatorExit<A>): void {
        if (lane.current.tag === 'run' || (lane.stopping && lane.current.tag === 'wake')) {
            if (lane.explicitWaiter !== undefined) {
                this.resolveWith(lane.explicitWaiter, exit);
                lane.explicitWaiter = undefined;
            }
        }
        if (this.active.get(key) !== lane) {
            this.settleDeferreds(lane, exit);
            return;
        }
        if (exit.status === 'success' && !lane.stopping) {
            if (lane.pending !== undefined) {
                this.promotePending(key, lane);
                return;
            }
            this.active.delete(key);
            this.settleDeferreds(lane, exit);
            return;
        }
        const pendingDemand = lane.pending;
        const pendingRunFn = lane.pendingRunFn;
        const transferredWaiter = lane.explicitWaiter;
        if (pendingDemand !== undefined) {
            const successor = this.makeLane(pendingDemand, pendingRunFn);
            successor.explicitWaiter = transferredWaiter;
            this.active.set(key, successor);
            void this.startSuccessor(key, successor);
        } else {
            this.active.delete(key);
        }
        this.settleDeferreds(lane, exit);
        if (
            exit.status === 'failure' &&
            !lane.stopping &&
            lane.current.tag === 'wake' &&
            this.onFailure !== undefined
        ) {
            this.onFailure(key, exit.error);
        }
    }

    private promotePending(key: string, lane: Lane<A>): void {
        const pending = lane.pending;
        if (pending === undefined) return;
        lane.current = pending;
        lane.runFn = lane.pendingRunFn;
        lane.pending = undefined;
        lane.pendingRunFn = undefined;
        void this.startSuccessor(key, lane);
    }

    private async startSuccessor(key: string, lane: Lane<A>): Promise<void> {
        await Promise.resolve();
        await this.startDrain(key, lane);
    }

    private settleDeferreds(lane: Lane<A>, exit: CoordinatorExit<A>): void {
        if (exit.status === 'success') {
            lane.done.resolve(exit.value);
        } else {
            lane.done.reject(exit.error);
        }
        lane.settled.resolve(exit);
    }

    private resolveWith(waiter: Deferred<A>, exit: CoordinatorExit<A>): void {
        if (exit.status === 'success') {
            waiter.resolve(exit.value);
        } else {
            waiter.reject(exit.error);
        }
    }

    private suppressPendingAtOrBefore(lane: Lane<A>, seq: number | undefined): void {
        const pending = lane.pending;
        if (pending?.tag === 'wake' && seq !== undefined && pending.seq !== undefined && pending.seq > seq) {
            return;
        }
        lane.pending = undefined;
        lane.pendingRunFn = undefined;
    }
}
