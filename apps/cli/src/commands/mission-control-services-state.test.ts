import { missionControlDataDirEnvKey } from '@mission-control/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    disposeAllMissionControlServices,
    MissionControlServices,
    resetMissionControlServicesCache,
} from './mission-control-services';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeWorkspace(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'mc-services-'));
}

async function makeWorkspaceWithMc(): Promise<string> {
    const workspace = await makeWorkspace();
    await mkdir(join(workspace, '.mc'), { recursive: true });
    return workspace;
}

describe('MissionControlServices aggregate state', () => {
    let workspaceA: string;
    let workspaceB: string;
    let dataDir: string;

    beforeEach(async () => {
        resetMissionControlServicesCache();
        workspaceA = await makeWorkspaceWithMc();
        workspaceB = await makeWorkspaceWithMc();
        dataDir = await mkdtemp(join(tmpdir(), 'mc-services-data-'));
        process.env[missionControlDataDirEnvKey] = dataDir;
    });

    afterEach(async () => {
        await disposeAllMissionControlServices();
        resetMissionControlServicesCache();
        delete process.env[missionControlDataDirEnvKey];
        const paths = [workspaceA, workspaceB, dataDir].filter((value) => value.length > 0);
        await Promise.allSettled(paths.map((path) => rm(path, { recursive: true, force: true })));
    });

    it('reflects all five job states simultaneously in the snapshot', async () => {
        const services = await MissionControlServices.create(workspaceA, { maxConcurrency: 2 });

        const done = services.getJobManager().startJob({
            sessionId: 'sess-mix-done',
            execute: async () => ({ status: 'completed', output: 'done' }),
        });
        await services.getJobManager().awaitJob(done.jobId);

        const failed = services.getJobManager().startJob({
            sessionId: 'sess-mix-fail',
            execute: async () => {
                throw new Error('mix-fail');
            },
        });
        await services.getJobManager().awaitJob(failed.jobId);

        const blocker = (signal: AbortSignal): Promise<{ status: 'completed'; output: string }> =>
            new Promise((_, reject) => {
                signal.addEventListener('abort', () => reject(new Error('job aborted')), { once: true });
            });
        services.getJobManager().startJob({ sessionId: 'sess-mix-run-1', execute: blocker });
        services.getJobManager().startJob({ sessionId: 'sess-mix-run-2', execute: blocker });
        await services.getJobManager().drainPreparations();
        services.getJobManager().startJob({
            sessionId: 'sess-mix-queued',
            execute: async () => ({ status: 'completed', output: 'q' }),
        });
        const toCancel = services.getJobManager().startJob({
            sessionId: 'sess-mix-cancel',
            execute: async () => ({ status: 'completed', output: 'c' }),
        });
        await services.getJobManager().drainPreparations();
        services.getJobManager().cancelJob(toCancel.jobId);

        const snapshot = services.snapshot();
        expect(snapshot.jobs.byStatus).toEqual({
            queued: 1,
            running: 2,
            completed: 1,
            failed: 1,
            cancelled: 1,
        });
        expect(snapshot.jobs.total).toBe(6);
        expect(snapshot.jobs.activeCount).toBe(2);

        await services.dispose();
    });

    it('reflects all four agent statuses simultaneously in the snapshot', async () => {
        const services = await MissionControlServices.create(workspaceA);
        const registry = services.getRuntimeRegistry();
        registry.adopt({
            id: 'a-run',
            displayName: 'Runner',
            kind: 'sub',
            status: 'running',
            sessionId: 's1',
        });
        registry.adopt({
            id: 'a-idle',
            displayName: 'Idler',
            kind: 'sub',
            status: 'idle',
            sessionId: 's2',
        });
        registry.adopt({
            id: 'a-park',
            displayName: 'Parker',
            kind: 'sub',
            status: 'parked',
            sessionId: 's3',
        });
        registry.adopt({
            id: 'a-abort',
            displayName: 'Aborter',
            kind: 'sub',
            status: 'aborted',
            sessionId: 's4',
        });

        const snapshot = services.snapshot();
        expect(snapshot.agents.byStatus).toEqual({
            running: 1,
            idle: 1,
            parked: 1,
            aborted: 1,
        });
        expect(snapshot.agents.visibleCount).toBe(4);

        await services.dispose();
    });

    it('dispose cleans up running jobs, lifecycle-adopted agents, and the registry together', async () => {
        const services = await MissionControlServices.create(workspaceA, { maxConcurrency: 2 });
        const registry = services.getRuntimeRegistry();
        const lifecycle = services.getLifecycleManager();

        services.getJobManager().startJob({
            sessionId: 'sess-dispose-block',
            execute: (): Promise<{ status: 'completed'; output: string }> =>
                new Promise<{ status: 'completed'; output: string }>(() => {}),
        });

        registry.adopt({
            id: 'lifecycle-adopted',
            displayName: 'Adopted',
            kind: 'sub',
            status: 'idle',
            sessionId: 'sess-adopted',
        });
        lifecycle.adopt('lifecycle-adopted');

        registry.adopt({
            id: 'transient-agent',
            displayName: 'Transient',
            kind: 'sub',
            status: 'running',
            sessionId: 'sess-transient',
        });

        await services.dispose();

        expect(services.isDisposed()).toBe(true);
        const snapshot = services.snapshot();
        expect(snapshot.jobs.byStatus.cancelled).toBeGreaterThanOrEqual(1);
        expect(snapshot.agents.visibleCount).toBe(0);
    });
});
