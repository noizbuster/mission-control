import { missionControlDataDirEnvKey } from '@mission-control/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    disposeAllMissionControlServices,
    getOrCreateMissionControlServices,
    resetMissionControlServicesCache,
} from './mission-control-services';
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

describe('MissionControlServices cache', () => {
    let workspaceA: string;
    let workspaceB: string;
    let dataDir: string;

    beforeEach(async () => {
        resetMissionControlServicesCache();
        workspaceA = await makeWorkspaceWithOmo();
        workspaceB = await makeWorkspaceWithOmo();
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

        it('ignores options on a cache hit because first construction wins', async () => {
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

        it('factory-provided maxConcurrency enforces the cap on the shared job manager', async () => {
            const services = await getOrCreateMissionControlServices(workspaceA, { maxConcurrency: 1 });
            services.getJobManager().startJob({
                sessionId: 'sess-factory-block',
                execute: abortCooperativeBlocker,
            });
            await services.getJobManager().drainPreparations();
            const queued = services.getJobManager().startJob({
                sessionId: 'sess-factory-next',
                execute: async () => ({ status: 'completed', output: 'ok' }),
            });
            await services.getJobManager().drainPreparations();

            expect(queued.status).toBe('queued');
            expect(services.snapshot().jobs.byStatus.queued).toBe(1);

            await services.dispose();
        });
    });

    describe('disposeAllMissionControlServices', () => {
        it('disposes every cached service, drains state, and clears the map', async () => {
            const servicesA = await getOrCreateMissionControlServices(workspaceA);
            const servicesB = await getOrCreateMissionControlServices(workspaceB);

            servicesA.getRuntimeRegistry().adopt({
                id: 'agent-dispose-all-a',
                displayName: 'Agent A',
                kind: 'sub',
                status: 'idle',
                sessionId: 'session-dispose-all-a',
            });
            servicesA.getJobManager().startJob({
                sessionId: 'session-dispose-all-a',
                execute: (): Promise<{ status: 'completed'; output: string }> =>
                    new Promise<{ status: 'completed'; output: string }>(() => {}),
            });
            servicesB.getRuntimeRegistry().adopt({
                id: 'agent-dispose-all-b',
                displayName: 'Agent B',
                kind: 'sub',
                status: 'running',
                sessionId: 'session-dispose-all-b',
            });

            await disposeAllMissionControlServices();

            expect(servicesA.isDisposed()).toBe(true);
            expect(servicesB.isDisposed()).toBe(true);
            expect(servicesA.snapshot().agents.visibleCount).toBe(0);
            expect(servicesA.snapshot().jobs.byStatus.cancelled).toBeGreaterThanOrEqual(1);
            expect(servicesB.snapshot().agents.visibleCount).toBe(0);

            const rebuiltA = await getOrCreateMissionControlServices(workspaceA);
            const rebuiltB = await getOrCreateMissionControlServices(workspaceB);
            expect(rebuiltA).not.toBe(servicesA);
            expect(rebuiltB).not.toBe(servicesB);
            expect(rebuiltA.isDisposed()).toBe(false);
            expect(rebuiltB.isDisposed()).toBe(false);

            await disposeAllMissionControlServices();
        });
    });
});

function abortCooperativeBlocker(signal: AbortSignal): Promise<{ status: 'completed'; output: string }> {
    return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('job aborted')), { once: true });
    });
}
