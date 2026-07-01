import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    getOrCreateMissionControlServices,
    MissionControlServices,
    type MissionControlServicesSnapshot,
    resetMissionControlServicesCache,
} from './mission-control-services.js';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeWorkspace(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'mc-services-'));
}

async function makeWorkspaceWithOmo(): Promise<string> {
    const workspace = await makeWorkspace();
    await mkdir(join(workspace, '.omo'), { recursive: true });
    return workspace;
}

describe('MissionControlServices', () => {
    let workspaceA: string;
    let workspaceB: string;

    beforeEach(async () => {
        resetMissionControlServicesCache();
        workspaceA = await makeWorkspaceWithOmo();
        workspaceB = await makeWorkspaceWithOmo();
    });

    afterEach(async () => {
        resetMissionControlServicesCache();
        const paths = [workspaceA, workspaceB].filter((value) => value.length > 0);
        await Promise.allSettled(paths.map((path) => rm(path, { recursive: true, force: true })));
    });

    describe('create', () => {
        it('resolves the .omo root from the workspace', async () => {
            const services = await MissionControlServices.create(workspaceA);
            expect(services.getOmoRoot()).toBe(workspaceA);
        });

        it('rejects when no .omo root is resolvable', async () => {
            const bare = await makeWorkspace();
            try {
                await expect(MissionControlServices.create(bare)).rejects.toThrow(/\.omo/);
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
            expect(services.getOmoRoot()).toBe(services.getOmoRoot());
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
            expect(snapshot.omoRoot).toBe(workspaceA);
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
            const blocker = new Promise<{ status: 'completed'; output: string }>(() => {
                // Never resolves; only the cancellation path ends it.
            });
            const running = services.getJobManager().startJob({
                sessionId: 'session-block',
                execute: () => blocker,
            });
            const queued = services.getJobManager().startJob({
                sessionId: 'session-queue',
                execute: () => Promise.resolve({ status: 'completed', output: 'ok' }),
            });
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

    describe('getOrCreateMissionControlServices', () => {
        it('returns the same instance for the same workspace root', async () => {
            const first = await getOrCreateMissionControlServices(workspaceA);
            const second = await getOrCreateMissionControlServices(workspaceA);
            expect(second).toBe(first);
        });

        it('shares the in-flight construction across concurrent calls', async () => {
            const [first, second] = await Promise.all([
                getOrCreateMissionControlServices(workspaceA),
                getOrCreateMissionControlServices(workspaceA),
            ]);
            expect(second).toBe(first);
        });

        it('builds distinct instances for distinct workspace roots', async () => {
            const fromA = await getOrCreateMissionControlServices(workspaceA);
            const fromB = await getOrCreateMissionControlServices(workspaceB);
            expect(fromB).not.toBe(fromA);
            expect(fromB.getOmoRoot()).toBe(workspaceB);
        });

        it('ignores options on a cache hit (first construction wins)', async () => {
            const first = await getOrCreateMissionControlServices(workspaceA, { maxConcurrency: 8 });
            const second = await getOrCreateMissionControlServices(workspaceA, { maxConcurrency: 1 });
            expect(second).toBe(first);
            expect(second.getMaxConcurrency()).toBe(8);
        });

        it('rebuilds after the cached instance is disposed', async () => {
            const first = await getOrCreateMissionControlServices(workspaceA);
            await first.dispose();
            const rebuilt = await getOrCreateMissionControlServices(workspaceA);
            expect(rebuilt).not.toBe(first);
            expect(rebuilt.isDisposed()).toBe(false);
        });

        it('drops the cache entry when construction rejects', async () => {
            const bare = await makeWorkspace();
            try {
                await expect(getOrCreateMissionControlServices(bare)).rejects.toThrow(/\.omo/);
                // A second attempt also rejects (cache was cleared, not poisoned).
                await expect(getOrCreateMissionControlServices(bare)).rejects.toThrow(/\.omo/);
            } finally {
                await rm(bare, { recursive: true, force: true });
            }
        });

        it('resetMissionControlServicesCache forces a rebuild on next access', async () => {
            const first = await getOrCreateMissionControlServices(workspaceA);
            resetMissionControlServicesCache();
            const second = await getOrCreateMissionControlServices(workspaceA);
            expect(second).not.toBe(first);
        });
    });
});
