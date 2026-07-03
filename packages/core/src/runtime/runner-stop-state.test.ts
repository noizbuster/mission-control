import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BoulderState, readBoulder, writeBoulder } from '../persistence/boulder-store.js';
import { ContinuationRuntime } from './continuation/continuation-runtime.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORK_ID = 'work-stop-state-test';

function makeBoulderState(workId: string): BoulderState {
    const now = new Date().toISOString();
    return {
        schema_version: 2,
        active_work_id: workId,
        works: {
            [workId]: {
                work_id: workId,
                active_plan: 'stop-test-plan',
                plan_name: 'Stop State Test',
                status: 'running',
                started_at: now,
                updated_at: now,
                session_ids: [],
                session_origins: {},
            },
        },
    };
}

describe('runner stop state persistence', () => {
    let tmpRoot: string;

    beforeEach(async () => {
        tmpRoot = mkdtempSync(join(tmpdir(), 'runner-stop-test-'));
        await writeBoulder(tmpRoot, makeBoulderState(WORK_ID));
    });

    afterEach(() => {
        rmSync(tmpRoot, { recursive: true, force: true });
    });

    function makeRuntime(): ContinuationRuntime {
        return new ContinuationRuntime({ maxIterations: 5, boulderRoot: tmpRoot, workId: WORK_ID });
    }

    it('runner_stop field is persisted on the boulder work after markStopped', async () => {
        const rt = makeRuntime();
        await rt.markStopped('budget_exceeded', '2026-07-03T10:00:00Z');

        const boulder = await readBoulder(tmpRoot);
        expect(boulder).not.toBeNull();
        const work = boulder?.works[WORK_ID];
        expect(work?.runner_stop).toEqual({
            stopped_at: '2026-07-03T10:00:00Z',
            stopped_reason: 'budget_exceeded',
        });
    });

    it('runner_stop field is removed from the boulder work after clearStopped', async () => {
        const rt = makeRuntime();
        await rt.markStopped('user_interrupt');
        await rt.clearStopped();

        const boulder = await readBoulder(tmpRoot);
        expect(boulder?.works[WORK_ID]?.runner_stop).toBeUndefined();
    });

    it('stopped work does not auto-continue across a fresh runtime instance', async () => {
        const rt1 = makeRuntime();
        await rt1.markStopped('process_restart');
        await rt1.persistState({
            iteration: 2,
            loopActive: true,
            doneSignal: false,
            lastSessionId: 'ses-prev',
            startedAt: '2026-07-01T00:00:00Z',
            stoppedAt: undefined,
            stoppedReason: undefined,
        });

        const rt2 = makeRuntime();
        const state = await rt2.loadState();
        expect(state).not.toBeNull();
        expect(state?.stoppedAt).toBeDefined();
        expect(rt2.shouldContinue(state!)).toBe(false);
    });

    it('explicit clearStopped re-enables continuation after a stop', async () => {
        const rt1 = makeRuntime();
        await rt1.markStopped('user_stop');
        await rt1.clearStopped();

        const rt2 = makeRuntime();
        const state = await rt2.loadState();
        expect(state?.stoppedAt).toBeUndefined();
        if (state) {
            expect(rt2.shouldContinue({ ...state, loopActive: true })).toBe(true);
        }
    });

    it('markStopped throws when the work does not exist', async () => {
        const rt = new ContinuationRuntime({ maxIterations: 5, boulderRoot: tmpRoot, workId: 'nonexistent' });
        await expect(rt.markStopped('test')).rejects.toThrow(/work nonexistent not found/);
    });

    it('markStopped throws when the boulder is missing', async () => {
        rmSync(join(tmpRoot, '.omo', 'boulder.json'), { force: true });
        const rt = makeRuntime();
        await expect(rt.markStopped('test')).rejects.toThrow(/boulder.json missing/);
    });

    it('clearStopped is safe when boulder is missing', async () => {
        rmSync(join(tmpRoot, '.omo', 'boulder.json'), { force: true });
        const rt = makeRuntime();
        await expect(rt.clearStopped()).resolves.toBeUndefined();
    });

    it('clearStopped is safe when work is missing', async () => {
        const rt = new ContinuationRuntime({ maxIterations: 5, boulderRoot: tmpRoot, workId: 'nonexistent' });
        await expect(rt.clearStopped()).resolves.toBeUndefined();
    });

    it('multiple markStopped calls update the marker timestamp and reason', async () => {
        const rt = makeRuntime();
        await rt.markStopped('first', '2026-07-01T00:00:00Z');
        await rt.markStopped('second', '2026-07-02T00:00:00Z');

        const boulder = await readBoulder(tmpRoot);
        expect(boulder?.works[WORK_ID]?.runner_stop).toEqual({
            stopped_at: '2026-07-02T00:00:00Z',
            stopped_reason: 'second',
        });
    });
});
