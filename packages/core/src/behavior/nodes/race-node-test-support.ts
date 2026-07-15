import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { collectSignals } from '../composite-node-test-helpers';
import type { AbgNodeRunContext } from '../node-registry';
import { createRaceNodeRunner } from './race-node';

const GRAPH_ID = 'graph_race_cleanup';
export const CLEANUP_TIMEOUT_MS = 25;
export const TEST_GUARD_MS = 50;
export const DONE = { done: true, value: undefined } as const satisfies IteratorResult<AbgSignal>;

export type SettlementObservation =
    | { readonly kind: 'settled'; readonly signals: readonly AbgSignal[] }
    | { readonly kind: 'guard_elapsed' };

export type Deferred<Value> = {
    readonly promise: Promise<Value>;
    readonly resolve: (value: Value) => void;
    readonly reject: (reason: unknown) => void;
};

export function runRace(loser: AsyncIterable<AbgSignal>, cleanupTimeoutMs: number): Promise<readonly AbgSignal[]> {
    const runner = createRaceNodeRunner((childId) => (childId === 'winner' ? validWinner() : loser));
    return collectSignals(runner(raceNode(['winner', 'loser'], cleanupTimeoutMs), runContext()));
}

export function raceNode(children: readonly string[], cleanupTimeoutMs?: number): AbgNodeSpec {
    return {
        id: 'race',
        kind: 'race',
        children: [...children],
        ...(cleanupTimeoutMs !== undefined ? { config: { cleanupTimeoutMs } } : {}),
    };
}

export function runContext(): AbgNodeRunContext {
    return { graphId: GRAPH_ID, now: () => '2026-07-13T00:00:00.000Z' };
}

export async function* validWinner(): AsyncIterable<AbgSignal> {
    yield validSuccess('winner');
}

export function validSuccess(nodeId: string): AbgSignal {
    return { type: 'success', graphId: GRAPH_ID, nodeId, result: { valid: true } };
}

export function iterable(iterator: AsyncIterator<AbgSignal>): AsyncIterable<AbgSignal> {
    return { [Symbol.asyncIterator]: () => iterator };
}

export function rejectingLoser(childId: string, message: string): AsyncIterable<AbgSignal> {
    return iterable({
        next: () => Promise.resolve(DONE),
        return: () => Promise.reject(new RaceReturnTestError(`${childId}: ${message}`)),
    });
}

export function observedRejectingLoser(childId: string, message: string) {
    const returnStarted = deferred<void>();
    const stream = iterable({
        next: () => Promise.resolve(DONE),
        return: () => {
            returnStarted.resolve(undefined);
            return Promise.reject(new RaceReturnTestError(`${childId}: ${message}`));
        },
    });
    return { stream, returnStarted };
}

export function cooperativeLoser(childId: string) {
    const pendingNext = deferred<IteratorResult<AbgSignal>>();
    const returnStarted = deferred<void>();
    const release = deferred<void>();
    const drained = deferred<void>();
    const stream = iterable({
        next: () => pendingNext.promise,
        return: async () => {
            returnStarted.resolve(undefined);
            await release.promise;
            pendingNext.resolve(DONE);
            drained.resolve(undefined);
            return DONE;
        },
    });
    return { childId, stream, returnStarted, release, drained };
}

export function deferred<Value>(): Deferred<Value> {
    let resolve: ((value: Value) => void) | undefined;
    let reject: ((reason: unknown) => void) | undefined;
    const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    if (resolve === undefined || reject === undefined) {
        throw new RaceDeferredTestError('deferred initialization failed');
    }
    return { promise, resolve, reject };
}

export function observeSettlement(settlement: Promise<readonly AbgSignal[]>): Promise<SettlementObservation> {
    return Promise.race([
        settlement.then((signals) => ({ kind: 'settled', signals }) satisfies SettlementObservation),
        new Promise<SettlementObservation>((resolve) => {
            setTimeout(() => resolve({ kind: 'guard_elapsed' }), TEST_GUARD_MS);
        }),
    ]);
}

export function hasFailureCode(signals: readonly AbgSignal[], nodeId: string, code: string): boolean {
    return signals.some((signal) => {
        if (signal.type !== 'failure' || signal.nodeId !== nodeId) return false;
        const error = signal.error;
        return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
    });
}

export class RaceReturnTestError extends Error {
    readonly name = 'RaceReturnTestError';
}

export class RacePumpTestError extends Error {
    readonly name = 'RacePumpTestError';
}

class RaceDeferredTestError extends Error {
    readonly name = 'RaceDeferredTestError';
}
