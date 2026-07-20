import { missionControlDataDirEnvKey } from '@mission-control/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    disposeAllMissionControlServices,
    MissionControlServices,
    type MissionControlServicesSnapshot,
    resetMissionControlServicesCache,
} from './mission-control-services';
import { existsSync } from 'node:fs';
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

describe('MissionControlServices', () => {
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

    describe('create', () => {
        it('resolves the .mc root from the workspace', async () => {
            const services = await MissionControlServices.create(workspaceA);
            expect(services.getMcRoot()).toBe(workspaceA);
        });

        it('rejects when no .mc root is resolvable', async () => {
            const bare = await makeWorkspace();
            try {
                await expect(MissionControlServices.create(bare)).rejects.toThrow(/\.mc/);
            } finally {
                await rm(bare, { recursive: true, force: true });
            }
        });

        it('applies default limits when no options are provided', async () => {
            const services = await MissionControlServices.create(workspaceA);
            expect(services.getMaxConcurrency()).toBe(4);
            expect(services.getDefaultIdleTtlMs()).toBe(420_000);
        });

        it('honors overridden limits', async () => {
            const services = await MissionControlServices.create(workspaceA, {
                maxConcurrency: 2,
                defaultIdleTtlMs: 1_000,
            });
            expect(services.getMaxConcurrency()).toBe(2);
            expect(services.getDefaultIdleTtlMs()).toBe(1_000);
        });

        it('writes runtime mirror rows to the shared Mission Control data-dir mission-control.db', async () => {
            const services = await MissionControlServices.create(workspaceA);
            services.getRuntimeRegistry().adopt({
                id: 'agent-data-dir',
                displayName: 'Data Dir',
                kind: 'sub',
                status: 'running',
                sessionId: 'session-data-dir',
            });
            await services.dispose();

            expect(existsSync(join(dataDir, 'mission-control.db'))).toBe(true);
            expect(existsSync(join(workspaceA, 'mission-control.db'))).toBe(false);
        });
    });

    describe('manager ownership', () => {
        it('constructs one of each manager', async () => {
            const services = await MissionControlServices.create(workspaceA);
            expect(services.getJobManager()).toBeInstanceOf(Object);
            expect(services.getLifecycleManager()).toBeInstanceOf(Object);
            expect(services.getRuntimeRegistry()).toBeInstanceOf(Object);
        });

        it('returns stable manager instances across accessor calls', async () => {
            const services = await MissionControlServices.create(workspaceA);
            expect(services.getJobManager()).toBe(services.getJobManager());
            expect(services.getLifecycleManager()).toBe(services.getLifecycleManager());
            expect(services.getRuntimeRegistry()).toBe(services.getRuntimeRegistry());
            expect(services.getMcRoot()).toBe(services.getMcRoot());
        });

        it('binds the lifecycle manager to the same registry it exposes', async () => {
            const services = await MissionControlServices.create(workspaceA);
            const registry = services.getRuntimeRegistry();
            // An agent adopted into the registry becomes visible to the lifecycle manager.
            registry.adopt({
                id: 'agent-a',
                displayName: 'Agent A',
                kind: 'sub',
                status: 'idle',
                sessionId: 'session-a',
            });
            expect(services.getLifecycleManager().has('agent-a')).toBe(false);
            services.getLifecycleManager().adopt('agent-a');
            expect(services.getLifecycleManager().has('agent-a')).toBe(true);
            await services.dispose();
        });
    });

    describe('snapshot', () => {
        it('exposes a serializable view with the expected shape', async () => {
            const services = await MissionControlServices.create(workspaceA, { maxConcurrency: 3 });
            const snapshot: MissionControlServicesSnapshot = services.snapshot();
            expect(snapshot.mcRoot).toBe(workspaceA);
            expect(snapshot.maxConcurrency).toBe(3);
            expect(snapshot.defaultIdleTtlMs).toBe(420_000);
            expect(snapshot.disposed).toBe(false);
            expect(snapshot.jobs).toEqual({
                activeCount: 0,
                total: 0,
                byStatus: { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
            });
            expect(snapshot.agents).toEqual({
                visibleCount: 0,
                byStatus: { running: 0, idle: 0, parked: 0, aborted: 0 },
            });
        });

        it('reflects jobs and agents as they are added', async () => {
            const services = await MissionControlServices.create(workspaceA);
            services.getRuntimeRegistry().adopt({
                id: 'agent-busy',
                displayName: 'Busy',
                kind: 'sub',
                status: 'running',
                sessionId: 'session-b',
            });
            services.getRuntimeRegistry().adopt({
                id: 'agent-idle',
                displayName: 'Idle',
                kind: 'sub',
                status: 'idle',
                sessionId: 'session-c',
            });
            const handle = services.getJobManager().startJob({
                sessionId: 'session-b',
                execute: () =>
                    new Promise((resolve) => {
                        resolve({ status: 'completed', output: 'done' });
                    }),
            });
            // Wait for the job to settle.
            await services.getJobManager().awaitJob(handle.jobId);

            const snapshot = services.snapshot();
            expect(snapshot.jobs.total).toBe(1);
            expect(snapshot.jobs.byStatus.completed).toBe(1);
            expect(snapshot.agents.visibleCount).toBe(2);
            expect(snapshot.agents.byStatus.running).toBe(1);
            expect(snapshot.agents.byStatus.idle).toBe(1);
        });
    });

    describe('dispose', () => {
        it('is idempotent', async () => {
            const services = await MissionControlServices.create(workspaceA);
            await services.dispose();
            await expect(services.dispose()).resolves.toBeUndefined();
            expect(services.isDisposed()).toBe(true);
        });

        it('reports disposed in the snapshot and clears the registry', async () => {
            const services = await MissionControlServices.create(workspaceA);
            services.getRuntimeRegistry().adopt({
                id: 'agent-x',
                displayName: 'X',
                kind: 'sub',
                status: 'idle',
                sessionId: 'session-x',
            });
            await services.dispose();
            const snapshot = services.snapshot();
            expect(snapshot.disposed).toBe(true);
            expect(snapshot.agents.visibleCount).toBe(0);
        });

        it('cancels queued jobs that never reached a concurrency slot', async () => {
            const services = await MissionControlServices.create(workspaceA, { maxConcurrency: 1 });
            const running = services.getJobManager().startJob({
                sessionId: 'session-block',
                execute: (signal) =>
                    new Promise((_, reject) => {
                        signal.addEventListener('abort', () => reject(new Error('job aborted')), { once: true });
                    }),
            });
            await services.getJobManager().drainPreparations();
            const queued = services.getJobManager().startJob({
                sessionId: 'session-queue',
                execute: () => Promise.resolve({ status: 'completed', output: 'ok' }),
            });
            await services.getJobManager().drainPreparations();
            // running occupies the single slot; queued waits.
            expect(services.snapshot().jobs.byStatus.queued).toBe(1);
            await services.dispose();
            const snapshot = services.snapshot();
            expect(snapshot.disposed).toBe(true);
            // The queued job is cancelled by dispose.
            expect(snapshot.jobs.byStatus.cancelled).toBeGreaterThanOrEqual(1);
            // Running job is also cancelled.
            expect(running.status === 'cancelled' || queued.status === 'cancelled').toBe(true);
        });
    });
});
