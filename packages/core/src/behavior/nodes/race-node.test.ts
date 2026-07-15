import type { AbgSignal } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectSignals } from '../composite-node-test-helpers.js';
import { createRaceNodeRunner } from './race-node.js';
import {
    CLEANUP_TIMEOUT_MS,
    cooperativeLoser,
    DONE,
    deferred,
    hasFailureCode,
    iterable,
    observedRejectingLoser,
    observeSettlement,
    RacePumpTestError,
    RaceReturnTestError,
    raceNode,
    rejectingLoser,
    runContext,
    runRace,
    TEST_GUARD_MS,
    validSuccess,
    validWinner,
} from './race-node-test-support.js';

afterEach(() => {
    vi.useRealTimers();
});

describe('Race cleanup settlement', () => {
    it('fails within cleanupTimeoutMs when loser return cannot overtake a pending next', async () => {
        vi.useFakeTimers();
        const loserEntered = deferred<void>();
        const releaseLoser = deferred<void>();
        const loserCleaned = deferred<void>();

        async function* stuckLoser(): AsyncIterable<AbgSignal> {
            try {
                loserEntered.resolve(undefined);
                await releaseLoser.promise;
                yield validSuccess('loser');
            } finally {
                loserCleaned.resolve(undefined);
            }
        }

        const settlement = runRace(stuckLoser(), CLEANUP_TIMEOUT_MS);
        await loserEntered.promise;
        const observation = observeSettlement(settlement);

        await vi.advanceTimersByTimeAsync(TEST_GUARD_MS);
        const observed = await observation;
        releaseLoser.resolve(undefined);
        await loserCleaned.promise;
        const signals = await settlement;

        expect(observed.kind).toBe('settled');
        expect(signals.at(-1)).toMatchObject({
            type: 'failure',
            nodeId: 'race',
            error: {
                code: 'race_cleanup_failed',
                failures: [{ code: 'race_cleanup_timeout', childIds: ['loser'] }],
            },
        });
        expect(signals.some((signal) => signal.type === 'success' && signal.nodeId === 'race')).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('surfaces iterator return rejection as child and parent cleanup failure', async () => {
        vi.useFakeTimers();
        const pendingNext = deferred<IteratorResult<AbgSignal>>();
        const loser = iterable({
            next: () => pendingNext.promise,
            return: () => Promise.reject(new RaceReturnTestError('loser return rejected')),
        });

        const settlement = runRace(loser, CLEANUP_TIMEOUT_MS);
        const observation = observeSettlement(settlement);

        await vi.advanceTimersByTimeAsync(TEST_GUARD_MS);
        const observed = await observation;
        pendingNext.resolve(DONE);
        const signals = await settlement;

        expect(observed.kind).toBe('settled');
        expect(hasFailureCode(signals, 'loser', 'race_child_drain_failed')).toBe(true);
        expect(signals.at(-1)).toMatchObject({
            type: 'failure',
            nodeId: 'race',
            error: {
                code: 'race_cleanup_failed',
                failures: [
                    { code: 'race_child_drain_failed', childId: 'loser', message: 'loser return rejected' },
                    { code: 'race_cleanup_timeout', childIds: ['loser'] },
                ],
            },
        });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('waits for cooperative losers after another iterator return rejects', async () => {
        const cooperative = cooperativeLoser('cooperative');
        const rejecting = observedRejectingLoser('rejecting', 'rejecting return failed');
        const runner = createRaceNodeRunner((childId) => {
            if (childId === 'cooperative') return cooperative.stream;
            if (childId === 'rejecting') return rejecting.stream;
            return validWinner();
        });
        let parentSettled = false;
        const settlement = collectSignals(runner(raceNode(['winner', 'rejecting', 'cooperative']), runContext())).then(
            (signals) => {
                parentSettled = true;
                return signals;
            },
        );

        await Promise.all([cooperative.returnStarted.promise, rejecting.returnStarted.promise]);
        expect(parentSettled).toBe(false);
        cooperative.release.resolve(undefined);
        await cooperative.drained.promise;
        const signals = await settlement;

        expect(hasFailureCode(signals, 'rejecting', 'race_child_drain_failed')).toBe(true);
        expect(signals.at(-1)).toMatchObject({ type: 'failure', nodeId: 'race' });
    });

    it('reports every iterator return rejection', async () => {
        const runner = createRaceNodeRunner((childId) => {
            if (childId === 'first') return rejectingLoser('first', 'first return failed');
            if (childId === 'second') return rejectingLoser('second', 'second return failed');
            return validWinner();
        });

        const signals = await collectSignals(
            runner(raceNode(['winner', 'first', 'second'], CLEANUP_TIMEOUT_MS), runContext()),
        );

        expect(hasFailureCode(signals, 'first', 'race_child_drain_failed')).toBe(true);
        expect(hasFailureCode(signals, 'second', 'race_child_drain_failed')).toBe(true);
        expect(signals.at(-1)).toMatchObject({
            type: 'failure',
            nodeId: 'race',
            error: {
                code: 'race_cleanup_failed',
                failures: [
                    { code: 'race_child_drain_failed', childId: 'first' },
                    { code: 'race_child_drain_failed', childId: 'second' },
                ],
            },
        });
    });

    it('handles a pending loser pump rejection after the parent has settled', async () => {
        vi.useFakeTimers();
        const pendingNext = deferred<IteratorResult<AbgSignal>>();
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);
        try {
            const loser = iterable({
                next: () => pendingNext.promise,
                return: () => Promise.resolve(DONE),
            });
            const settlement = runRace(loser, CLEANUP_TIMEOUT_MS);
            const observation = observeSettlement(settlement);

            await vi.advanceTimersByTimeAsync(TEST_GUARD_MS);
            const observed = await observation;
            pendingNext.reject(new RacePumpTestError('late loser rejection'));
            const signals = await settlement;
            await Promise.resolve();
            await Promise.resolve();

            expect(observed.kind).toBe('settled');
            expect(signals.at(-1)).toMatchObject({
                type: 'failure',
                nodeId: 'race',
                error: {
                    code: 'race_cleanup_failed',
                    failures: [{ code: 'race_cleanup_timeout', childIds: ['loser'] }],
                },
            });
            expect(unhandled).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });

    it('drains every cooperative loser before returning parent success', async () => {
        const first = cooperativeLoser('first');
        const second = cooperativeLoser('second');
        const runner = createRaceNodeRunner((childId) => {
            if (childId === 'first') return first.stream;
            if (childId === 'second') return second.stream;
            return validWinner();
        });
        let parentSettled = false;
        const settlement = collectSignals(runner(raceNode(['winner', 'first', 'second']), runContext())).then(
            (signals) => {
                parentSettled = true;
                return signals;
            },
        );

        await Promise.all([first.returnStarted.promise, second.returnStarted.promise]);
        expect(parentSettled).toBe(false);
        first.release.resolve(undefined);
        await first.drained.promise;
        expect(parentSettled).toBe(false);
        second.release.resolve(undefined);
        await second.drained.promise;
        const signals = await settlement;

        expect(signals.at(-1)).toMatchObject({ type: 'success', result: { winnerChild: 'winner' } });
        expect(parentSettled).toBe(true);
    });
});
