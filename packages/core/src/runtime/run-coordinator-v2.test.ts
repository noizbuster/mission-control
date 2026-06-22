import { describe, expect, it } from 'vitest';
import { coalesceDemand, RunCoordinatorV2 } from './run-coordinator-v2.js';
import { SessionInputDelivery } from './session-input-delivery.js';

function makeTestDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    const ref: { resolve: ((value: T) => void) | undefined } = { resolve: undefined };
    const promise = new Promise<T>((resolve) => {
        ref.resolve = resolve;
    });
    return {
        promise,
        resolve: (value: T) => {
            const fn = ref.resolve;
            if (fn !== undefined) fn(value);
        },
    };
}

describe('RunCoordinatorV2', () => {
    it('run(key) executes the drain and returns the result', async () => {
        const coord = new RunCoordinatorV2<string>({
            drain: async () => 'result',
        });
        const result = await coord.run('s1');
        expect(result).toBe('result');
    });

    it('wake(key) while drain active coalesces (drain re-runs)', async () => {
        let calls = 0;
        const gate = makeTestDeferred<void>();
        const coord = new RunCoordinatorV2<number>({
            drain: async () => {
                calls += 1;
                if (calls === 1) await gate.promise;
                return calls;
            },
        });
        coord.wake('s1');
        coord.wake('s1');
        gate.resolve(undefined);
        await coord.awaitIdle('s1');
        expect(calls).toBe(2);
    });

    it('run dominates wake (both pending -> run wins)', async () => {
        const modes: string[] = [];
        const gate = makeTestDeferred<void>();
        const coord = new RunCoordinatorV2<void>({
            drain: async (_key, mode) => {
                modes.push(mode);
                if (modes.length === 1) await gate.promise;
            },
        });
        coord.wake('s1');
        coord.wake('s1');
        void coord.run('s1');
        gate.resolve(undefined);
        await coord.awaitIdle('s1');
        expect(modes).toEqual(['wake', 'run']);
    });

    it('same-key second run joins the first (both get same result)', async () => {
        const gate = makeTestDeferred<void>();
        const coord = new RunCoordinatorV2<string>({
            drain: async () => {
                await gate.promise;
                return 'shared';
            },
        });
        const p1 = coord.run('s1');
        const p2 = coord.run('s1');
        gate.resolve(undefined);
        const [r1, r2] = await Promise.all([p1, p2]);
        expect(r1).toBe('shared');
        expect(r2).toBe('shared');
    });

    it('different keys run concurrently', async () => {
        let concurrent = 0;
        let maxConcurrent = 0;
        const gateMap = new Map<string, { promise: Promise<void>; resolve: (v: undefined) => void }>();
        const coord = new RunCoordinatorV2<void>({
            drain: async (key) => {
                concurrent += 1;
                maxConcurrent = Math.max(maxConcurrent, concurrent);
                const gate = makeTestDeferred<void>();
                gateMap.set(key, gate);
                await gate.promise;
                concurrent -= 1;
            },
        });
        const p1 = coord.run('a');
        const p2 = coord.run('b');
        gateMap.get('a')?.resolve(undefined);
        gateMap.get('b')?.resolve(undefined);
        await Promise.all([p1, p2]);
        expect(maxConcurrent).toBe(2);
    });

    it('interrupt(key) cancels active drain (AbortSignal aborted)', async () => {
        let aborted = false;
        const gate = makeTestDeferred<void>();
        const coord = new RunCoordinatorV2<void>({
            drain: async (_key, _mode, signal) => {
                const onAbort = () => {
                    aborted = true;
                };
                signal.addEventListener('abort', onAbort);
                try {
                    await gate.promise;
                } finally {
                    signal.removeEventListener('abort', onAbort);
                }
            },
        });
        coord.wake('s1');
        coord.interrupt('s1');
        expect(aborted).toBe(true);
        gate.resolve(undefined);
        await coord.awaitIdle('s1');
    });
});

describe('coalesceDemand', () => {
    it('run + wake -> run', () => {
        expect(coalesceDemand({ tag: 'run' }, { tag: 'wake', seq: 5 })).toEqual({ tag: 'run' });
    });

    it('wake + run -> run', () => {
        expect(coalesceDemand({ tag: 'wake', seq: 5 }, { tag: 'run' })).toEqual({ tag: 'run' });
    });

    it('wake + wake -> wake(max seq)', () => {
        expect(coalesceDemand({ tag: 'wake', seq: 3 }, { tag: 'wake', seq: 7 })).toEqual({
            tag: 'wake',
            seq: 7,
        });
        expect(coalesceDemand({ tag: 'wake', seq: 9 }, { tag: 'wake', seq: 2 })).toEqual({
            tag: 'wake',
            seq: 9,
        });
    });
});

describe('SessionInputDelivery', () => {
    it('steers drain FIFO, queued drain FIFO', () => {
        const delivery = new SessionInputDelivery();
        delivery.admitInput('s1', { inputId: 'i1', prompt: 'a' }, 'steer');
        delivery.admitInput('s1', { inputId: 'i2', prompt: 'b' }, 'steer');
        delivery.admitInput('s1', { inputId: 'i3', prompt: 'c' }, 'queue');
        delivery.admitInput('s1', { inputId: 'i4', prompt: 'd' }, 'queue');

        const steers = delivery.promoteSteers('s1');
        expect(steers.map((r) => r.inputId)).toEqual(['i1', 'i2']);
        expect(delivery.pendingSteerCount('s1')).toBe(0);

        expect(delivery.promoteNextQueued('s1')?.inputId).toBe('i3');
        expect(delivery.promoteNextQueued('s1')?.inputId).toBe('i4');
        expect(delivery.promoteNextQueued('s1')).toBeUndefined();
        expect(delivery.pendingQueuedCount('s1')).toBe(0);
    });

    it('admittedAt is monotonic across deliveries', () => {
        const delivery = new SessionInputDelivery();
        const a = delivery.admitInput('s1', { inputId: 'i1', prompt: 'a' }, 'steer');
        const b = delivery.admitInput('s1', { inputId: 'i2', prompt: 'b' }, 'queue');
        const c = delivery.admitInput('s2', { inputId: 'i3', prompt: 'c' }, 'steer');
        expect(b.admittedAt).toBeGreaterThan(a.admittedAt);
        expect(c.admittedAt).toBeGreaterThan(b.admittedAt);
    });
});
