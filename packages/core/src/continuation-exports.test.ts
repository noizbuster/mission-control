import {
    type ContinuationOptions,
    type ContinuationOutcome,
    ContinuationRuntime,
    ContinuationRuntimeError,
    type ContinuationState,
} from '@mission-control/core';
import { describe, expect, it } from 'vitest';

/**
 * Import-contract test: the read-only continuation inspection surface must be
 * reachable as named imports from the `@mission-control/core` package entry
 * point. Active continuation driving (`runWithContinuation`, `RunGraphFn`,
 * `GraphRunContinuationResult`) is intentionally out of scope and must NOT be
 * exported by this change.
 */
describe('continuation runtime read-only public exports', () => {
    const VALUES: ReadonlyArray<readonly [string, unknown]> = [
        ['ContinuationRuntime', ContinuationRuntime],
        ['ContinuationRuntimeError', ContinuationRuntimeError],
    ];

    it.each(VALUES)('%s is exported and defined', (_name, value) => {
        expect(value).toBeDefined();
    });

    it('exports ContinuationRuntime as a class', () => {
        expect(typeof ContinuationRuntime).toBe('function');
        // class constructors report a prototype object.
        expect(ContinuationRuntime.prototype).toBeInstanceOf(Object);
    });

    it('exports ContinuationRuntimeError as an Error subclass', () => {
        expect(typeof ContinuationRuntimeError).toBe('function');
        const error = new ContinuationRuntimeError('boom', 'test_code');
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe('boom');
        expect(error.code).toBe('test_code');
    });

    it('read methods exist on the runtime class (loadState, shouldContinue)', () => {
        expect(typeof ContinuationRuntime.prototype.loadState).toBe('function');
        expect(typeof ContinuationRuntime.prototype.shouldContinue).toBe('function');
        expect(typeof ContinuationRuntime.prototype.initialState).toBe('function');
    });

    it('constructs a runtime from ContinuationOptions without invoking driving paths', () => {
        const options: ContinuationOptions = {
            maxIterations: 3,
            boulderRoot: '/nonexistent-readonly-inspection-root',
            workId: 'work-inspect',
        };
        const runtime = new ContinuationRuntime(options);
        const initial: ContinuationState = runtime.initialState('2026-07-02T00:00:00.000Z');
        expect(initial.iteration).toBe(0);
        expect(initial.loopActive).toBe(false);
        expect(initial.doneSignal).toBe(false);
        // shouldContinue is a pure read over a fresh inactive state.
        expect(runtime.shouldContinue(initial)).toBe(false);
    });

    it('ContinuationOutcome discriminated union type is reachable (compile-time contract)', () => {
        // This assertion exists to keep the type import live; values are not
        // constructed here because the union is a driving-path result type.
        const doneOutcome: ContinuationOutcome = {
            status: 'done',
            iterations: 0,
            reason: 'loop_inactive',
        };
        const continueOutcome: ContinuationOutcome = {
            status: 'continue',
            sessionId: 'session-inspect',
            iteration: 1,
        };
        expect(doneOutcome.status).toBe('done');
        expect(continueOutcome.status).toBe('continue');
    });
});
