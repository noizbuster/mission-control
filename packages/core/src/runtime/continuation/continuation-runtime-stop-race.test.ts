import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BoulderState, boulderFilePath, readBoulder, writeBoulder } from '../../persistence/boulder-store';
import { ContinuationRuntime, type ContinuationState } from './continuation-runtime';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workId = 'work-continuation-stop-race';
let root = '';

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mctrl-continuation-stop-race-'));
    await writeBoulder(root, boulderState());
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('continuation stop admission and persistence', () => {
    it('does not call the graph when runner_stop exists without continuation state', async () => {
        const runtime = createRuntime();
        await runtime.markStopped('operator stop', '2026-07-12T00:00:00.000Z');
        let graphRuns = 0;

        const outcome = await runtime.runWithContinuation('session-after-restart', async () => {
            graphRuns += 1;
            return { loopActive: true, done: false, output: null };
        });

        expect(outcome).toEqual({ status: 'done', iterations: 0, reason: 'stopped' });
        expect(graphRuns).toBe(0);
    });

    it('does not call the graph when runner_stop exists with malformed continuation state', async () => {
        const state = boulderState();
        const work = state.works[workId];
        if (work === undefined) throw new TypeError('continuation test work is missing');
        await writeBoulder(root, {
            ...state,
            works: {
                ...state.works,
                [workId]: {
                    ...work,
                    continuation_runtime: { iteration: 'invalid' },
                    runner_stop: {
                        stopped_at: '2026-07-12T00:00:00.000Z',
                        stopped_reason: 'operator stop',
                    },
                },
            },
        });
        const runtime = createRuntime();
        let graphRuns = 0;

        const outcome = await runtime.runWithContinuation('session-after-corruption', async () => {
            graphRuns += 1;
            return { loopActive: true, done: false, output: null };
        });

        expect(outcome).toEqual({ status: 'done', iterations: 0, reason: 'stopped' });
        expect(graphRuns).toBe(0);
    });

    it('preserves runner_stop during a concurrent continuation state write', async () => {
        const runtime = createRuntime();

        await Promise.all([
            runtime.markStopped('concurrent stop', '2026-07-12T00:00:00.000Z'),
            runtime.persistState(activeState()),
        ]);

        const work = (await readBoulder(root))?.works[workId];
        expect(work?.runner_stop).toEqual({
            stopped_at: '2026-07-12T00:00:00.000Z',
            stopped_reason: 'concurrent stop',
        });
        expect(await runtime.loadState()).toMatchObject({ stoppedReason: 'concurrent stop' });
    });

    it('fails closed when another process holds the boulder mutation lock', async () => {
        const lockPath = `${boulderFilePath(root)}.lock`;
        await writeFile(lockPath, 'external-process\n', { flag: 'wx' });
        const runtime = createRuntime();

        await expect(runtime.markStopped('must not overwrite')).rejects.toMatchObject({ code: 'boulder_lock_busy' });

        const work = (await readBoulder(root))?.works[workId];
        expect(work?.runner_stop).toBeUndefined();
    });
});

function createRuntime(): ContinuationRuntime {
    return new ContinuationRuntime({ maxIterations: 5, boulderRoot: root, workId });
}

function activeState(): ContinuationState {
    return {
        iteration: 1,
        loopActive: true,
        doneSignal: false,
        lastSessionId: 'session-before-stop',
        startedAt: '2026-07-12T00:00:00.000Z',
    };
}

function boulderState(): BoulderState {
    return {
        schema_version: 2,
        active_work_id: workId,
        works: {
            [workId]: {
                work_id: workId,
                active_plan: '.omo/plans/continuation-stop-race.md',
                plan_name: 'continuation-stop-race',
                status: 'running',
                started_at: '2026-07-12T00:00:00.000Z',
                updated_at: '2026-07-12T00:00:00.000Z',
                session_ids: [],
                session_origins: {},
            },
        },
    };
}
