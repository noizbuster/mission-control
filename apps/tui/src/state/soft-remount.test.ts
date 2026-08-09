import { describe, expect, it, vi } from 'vitest';
import { createSoftRemountController } from './soft-remount';

describe('SoftRemountController', () => {
    it('bumps generation and records the last request', async () => {
        let now = 1_000;
        const controller = createSoftRemountController({ now: () => now, minIntervalMs: 0 });
        expect(controller.getGeneration()).toBe(0);

        const first = await controller.requestRemount('render_error', 'boom');
        expect(first).toEqual({
            generation: 1,
            reason: 'render_error',
            message: 'boom',
            at: 1_000,
            advanced: true,
        });
        expect(controller.getGeneration()).toBe(1);
        expect(controller.getLastRequest()).toEqual(first);

        now = 1_001;
        await controller.requestRemount('manual');
        expect(controller.getGeneration()).toBe(2);
    });

    it('notifies subscribers and best-effort reloads the snapshot', async () => {
        const reloadSnapshot = vi.fn(async () => {});
        const listener = vi.fn();
        let now = 42;
        const controller = createSoftRemountController({
            reloadSnapshot,
            now: () => now,
            minIntervalMs: 0,
        });
        const dispose = controller.subscribe(listener);

        await controller.requestRemount('snapshot_heal', 'empty store');
        expect(listener).toHaveBeenCalledOnce();
        expect(reloadSnapshot).toHaveBeenCalledOnce();

        dispose();
        now = 43;
        await controller.requestRemount('manual');
        expect(listener).toHaveBeenCalledOnce();
    });

    it('still remounts when snapshot reload throws', async () => {
        const controller = createSoftRemountController({
            reloadSnapshot: async () => {
                throw new Error('db locked');
            },
        });
        await expect(controller.requestRemount('render_error')).resolves.toMatchObject({
            generation: 1,
            reason: 'render_error',
        });
    });

    it('cancels a delayed follow-up and makes later requests no-ops after disposal', async () => {
        vi.useFakeTimers();
        try {
            let now = 1_000;
            const reloadSnapshot = vi.fn(async () => {});
            const listener = vi.fn();
            const controller = createSoftRemountController({
                reloadSnapshot,
                now: () => now,
                minIntervalMs: 50,
            });
            controller.subscribe(listener);

            await controller.requestRemount('manual');
            const queued = controller.requestRemount('render_error', 'late render error');
            expect(vi.getTimerCount()).toBe(1);

            controller.dispose();
            expect(vi.getTimerCount()).toBe(0);
            await expect(queued).resolves.toMatchObject({
                generation: 1,
                advanced: false,
            });
            await expect(controller.requestRemount('manual')).resolves.toMatchObject({
                generation: 1,
                advanced: false,
            });
            now += 100;
            await vi.runAllTimersAsync();

            expect(controller.getGeneration()).toBe(1);
            expect(reloadSnapshot).toHaveBeenCalledOnce();
            expect(listener).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('SoftRemountController thrash protection', () => {
    it('coalesces concurrent requestRemount calls onto one generation', async () => {
        let now = 1_000;
        const reloadSnapshot = vi.fn(async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
        });
        const controller = createSoftRemountController({
            reloadSnapshot,
            now: () => now,
            minIntervalMs: 50,
        });
        const listener = vi.fn();
        controller.subscribe(listener);

        const first = controller.requestRemount('render_error', 'a');
        const second = controller.requestRemount('render_error', 'b');
        const [a, b] = await Promise.all([first, second]);
        expect(a.generation).toBe(1);
        expect(b.generation).toBe(1);
        expect(reloadSnapshot).toHaveBeenCalledTimes(1);
        // One publish for the single generation bump (follow-up may add more after settle).
        expect(listener.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(controller.getGeneration()).toBeGreaterThanOrEqual(1);
    });

    it('still allows a later remount after the in-flight work settles', async () => {
        let now = 5_000;
        const controller = createSoftRemountController({
            now: () => now,
            minIntervalMs: 10,
        });
        await controller.requestRemount('manual');
        expect(controller.getGeneration()).toBe(1);
        now = 5_050;
        await controller.requestRemount('manual');
        expect(controller.getGeneration()).toBe(2);
    });
});

describe('SoftRemountController circuit breaker', () => {
    it('opens a circuit after maxConsecutive bumps inside the window', async () => {
        let now = 10_000;
        const controller = createSoftRemountController({
            now: () => now,
            minIntervalMs: 0,
            maxConsecutive: 3,
            consecutiveWindowMs: 5_000,
        });
        await controller.requestRemount('render_error', '1');
        now += 1;
        await controller.requestRemount('render_error', '2');
        now += 1;
        await controller.requestRemount('render_error', '3');
        expect(controller.getGeneration()).toBe(3);
        now += 1;
        const blocked = await controller.requestRemount('render_error', '4');
        expect(blocked.generation).toBe(3);
        expect(blocked.advanced).toBe(false);
        expect(controller.getGeneration()).toBe(3);
        expect(controller.isCircuitOpen()).toBe(true);
    });
});
