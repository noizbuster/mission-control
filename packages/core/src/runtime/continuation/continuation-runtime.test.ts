import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BoulderState, writeBoulder } from '../../persistence/boulder-store.js';
import {
    ContinuationRuntime,
    type ContinuationState,
    type GraphRunContinuationResult,
} from './continuation-runtime.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORK_ID = 'work-continuation-test';

function makeBoulderState(workId: string): BoulderState {
    const now = new Date().toISOString();
    return {
        schema_version: 2,
        active_work_id: workId,
        works: {
            [workId]: {
                work_id: workId,
                active_plan: 'test-plan',
                plan_name: 'Test Plan',
                status: 'running',
                started_at: now,
                updated_at: now,
                session_ids: [],
                session_origins: {},
            },
        },
    };
}

function makeState(overrides: Partial<ContinuationState> = {}): ContinuationState {
    return {
        iteration: 0,
        loopActive: false,
        doneSignal: false,
        lastSessionId: undefined,
        startedAt: '2026-06-22T00:00:00Z',
        ...overrides,
    };
}

const looping = (): GraphRunContinuationResult => ({ loopActive: true, done: false, output: 'working' });
const finished = (): GraphRunContinuationResult => ({ loopActive: false, done: true, output: 'done' });

describe('ContinuationRuntime', () => {
    let tmpRoot: string;

    beforeEach(async () => {
        tmpRoot = mkdtempSync(join(tmpdir(), 'continuation-test-'));
        await writeBoulder(tmpRoot, makeBoulderState(WORK_ID));
    });

    afterEach(() => {
        rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('fresh runtime starts at iteration 0, loopActive false, doneSignal false', () => {
        const rt = new ContinuationRuntime({ maxIterations: 5, boulderRoot: tmpRoot, workId: WORK_ID });
        const state = rt.initialState('2026-01-01T00:00:00Z');
        expect(state).toEqual(makeState({ startedAt: '2026-01-01T00:00:00Z' }));
    });

    it('shouldContinue is true only when loopActive, not done, below max', () => {
        const rt = new ContinuationRuntime({ maxIterations: 3, boulderRoot: tmpRoot, workId: WORK_ID });
        expect(rt.shouldContinue(makeState({ loopActive: true }))).toBe(true);
        expect(rt.shouldContinue(makeState({ loopActive: false }))).toBe(false);
        expect(rt.shouldContinue(makeState({ loopActive: true, doneSignal: true }))).toBe(false);
        expect(rt.shouldContinue(makeState({ loopActive: true, iteration: 3 }))).toBe(false);
    });

    it('advance increments iteration and updates sessionId', () => {
        const rt = new ContinuationRuntime({ maxIterations: 5, boulderRoot: tmpRoot, workId: WORK_ID });
        const after = rt.advance(makeState({ iteration: 2, lastSessionId: 'ses-old' }), 'ses-new');
        expect(after.iteration).toBe(3);
        expect(after.lastSessionId).toBe('ses-new');
        expect(after.loopActive).toBe(false);
    });

    it('signalDone sets doneSignal true, making shouldContinue false', () => {
        const rt = new ContinuationRuntime({ maxIterations: 5, boulderRoot: tmpRoot, workId: WORK_ID });
        const after = rt.signalDone(makeState({ loopActive: true }));
        expect(after.doneSignal).toBe(true);
        expect(rt.shouldContinue(after)).toBe(false);
    });

    it('persistState then loadState returns the same data', async () => {
        const rt = new ContinuationRuntime({ maxIterations: 5, boulderRoot: tmpRoot, workId: WORK_ID });
        const state = makeState({ iteration: 3, loopActive: true, lastSessionId: 'ses-abc' });
        await rt.persistState(state);
        expect(await rt.loadState()).toEqual(state);
    });

    it('loadState returns null when no continuation state exists', async () => {
        const rt = new ContinuationRuntime({ maxIterations: 5, boulderRoot: tmpRoot, workId: WORK_ID });
        expect(await rt.loadState()).toBeNull();
    });

    it('state resumes across a fresh runtime instance (session-spanning)', async () => {
        const rt1 = new ContinuationRuntime({ maxIterations: 5, boulderRoot: tmpRoot, workId: WORK_ID });
        const state = makeState({ iteration: 2, loopActive: true, lastSessionId: 'ses-prev' });
        await rt1.persistState(state);

        const rt2 = new ContinuationRuntime({ maxIterations: 5, boulderRoot: tmpRoot, workId: WORK_ID });
        expect(await rt2.loadState()).toEqual(state);
    });

    it('runWithContinuation continues when runGraphFn returns loopActive=true', async () => {
        const rt = new ContinuationRuntime({ maxIterations: 5, boulderRoot: tmpRoot, workId: WORK_ID });
        const result = await rt.runWithContinuation('ses-1', async () => looping());
        expect(result.status).toBe('continue');
        if (result.status === 'continue') {
            expect(result.iteration).toBe(1);
            expect(result.sessionId).not.toBe('ses-1');
        }
    });

    it('runWithContinuation stops when runGraphFn returns done=true', async () => {
        const rt = new ContinuationRuntime({ maxIterations: 5, boulderRoot: tmpRoot, workId: WORK_ID });
        const result = await rt.runWithContinuation('ses-1', async () => finished());
        expect(result.status).toBe('done');
        if (result.status === 'done') {
            expect(result.reason).toBe('done_signal');
            expect(result.iterations).toBe(0);
        }
    });

    it('runWithContinuation stops at max iterations even with loopActive', async () => {
        const rt = new ContinuationRuntime({ maxIterations: 1, boulderRoot: tmpRoot, workId: WORK_ID });
        const first = await rt.runWithContinuation('ses-1', async () => looping());
        expect(first.status).toBe('continue');
        const nextId = first.status === 'continue' ? first.sessionId : 'ses-2';
        const second = await rt.runWithContinuation(nextId, async () => looping());
        expect(second.status).toBe('done');
        if (second.status === 'done') expect(second.reason).toBe('max_iterations');
    });

    it('runWithContinuation resumes from persisted state across sessions', async () => {
        const rt1 = new ContinuationRuntime({ maxIterations: 5, boulderRoot: tmpRoot, workId: WORK_ID });
        const first = await rt1.runWithContinuation('ses-1', async () => looping());
        expect(first.status).toBe('continue');
        const nextId = first.status === 'continue' ? first.sessionId : 'ses-2';

        const rt2 = new ContinuationRuntime({ maxIterations: 5, boulderRoot: tmpRoot, workId: WORK_ID });
        const second = await rt2.runWithContinuation(nextId, async () => looping());
        expect(second.status).toBe('continue');
        if (second.status === 'continue') expect(second.iteration).toBe(2);
    });
});
