import type { Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSqlTaskRuntimeServices } from '../agents/sql-task-runtime-services.js';
import { SqlContextEpochStore } from '../context/system-context-epoch-store.js';
import { openLocalSessionEventStore } from '../memory/local-session-store-open.js';
import { openSqliteSessionProjectionStore } from '../memory/sqlite-session-projection.js';
import { TursoPersistentStore } from '../memory/turso-persistent-store.js';
import { createDeterministicProvider } from '../providers/deterministic-provider.js';
import { SessionRunOwnerRegistry } from '../runtime/run-owner.js';
import { SqlSessionInputDelivery } from '../runtime/session-input-delivery-sql.js';
import { runLocalLibsqlWrite } from './local-libsql-db.js';
import { openMissionControlDb } from './mission-control-db.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const libsqlObservation = vi.hoisted(() => ({
    clients: [] as Client[],
    createClient: vi.fn(),
}));

vi.mock('@libsql/client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@libsql/client')>();
    libsqlObservation.createClient.mockImplementation((config: Parameters<typeof actual.createClient>[0]) => {
        const client = actual.createClient(config);
        vi.spyOn(client, 'close');
        libsqlObservation.clients.push(client);
        return client;
    });
    return { ...actual, createClient: libsqlObservation.createClient };
});

const tempDirs: string[] = [];

beforeEach(() => {
    vi.clearAllMocks();
    libsqlObservation.clients.length = 0;
});

afterEach(async () => {
    await settleScheduledClose();
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Mission Control database product leases', () => {
    it('shares one physical client until every concurrent product owner drains and releases', async () => {
        // Given
        const dataDir = await makeTempDataDir('owners');
        const eventStore = await openLocalSessionEventStore({
            dataDir,
            sessionId: 'session_shared_owners',
            createEventId: (_event, sequence) => `event_${sequence}`,
        });
        const persistentLease = await openMissionControlDb({ dataDir });
        const observerLease = await openMissionControlDb({ dataDir });
        const persistentStore = TursoPersistentStore.fromRuntime(persistentLease);
        const projectionStore = await openSqliteSessionProjectionStore({ dataDir });
        const taskServices = await createSqlTaskRuntimeServices(dataDir, { recoverActiveJobs: false });
        const delivery = await SqlSessionInputDelivery.open({ dataDir });
        const epochStore = await SqlContextEpochStore.open({ dataDir });
        await eventStore.append({
            type: 'session.started',
            timestamp: '2026-07-12T00:00:00.000Z',
            sessionId: 'session_shared_owners',
            nativeSidecarStatus: 'mock',
        });
        await persistentStore.set('goal', 'task-8', 'shared-client');
        await delivery.admitInput(
            'session_shared_owners',
            { inputId: 'input_shared_owners', prompt: 'continue' },
            'queue',
        );
        await epochStore.recordEpoch({
            sessionId: 'session_shared_owners',
            epoch: 1,
            sourceId: 'task-8',
            updateText: 'shared client',
        });
        expect(await projectionStore.getSession('session_shared_owners')).not.toBeNull();
        let markJobStarted = (): void => undefined;
        let releaseJob = (): void => undefined;
        const jobStarted = new Promise<void>((resolve) => {
            markJobStarted = resolve;
        });
        const jobRelease = new Promise<void>((resolve) => {
            releaseJob = resolve;
        });
        taskServices.jobManager.startJob({
            sessionId: 'child_shared_owners',
            parentSessionId: 'session_shared_owners',
            agentId: 'deep',
            blocking: false,
            execute: async () => {
                markJobStarted();
                await jobRelease;
                return { status: 'completed', output: 'drained' };
            },
        });
        await jobStarted;
        const firstPhysicalClient = libsqlObservation.clients[0];
        expect(persistentLease).not.toBe(observerLease);
        expect(persistentLease.close).not.toBe(observerLease.close);
        expect(persistentLease.client).toBe(observerLease.client);

        // When
        const closingTaskServices = taskServices.close();
        persistentStore.close();
        observerLease.close();
        projectionStore.close();
        delivery.close();
        epochStore.close();
        await eventStore.close();
        await settleScheduledClose();

        // Then
        expect(libsqlObservation.createClient).toHaveBeenCalledTimes(1);
        expect(firstPhysicalClient?.close).not.toHaveBeenCalled();
        releaseJob();
        await closingTaskServices;
        await settleScheduledClose();
        expect(firstPhysicalClient?.close).toHaveBeenCalledOnce();

        const reopened = await openMissionControlDb({ dataDir });
        expect(reopened.client).not.toBe(firstPhysicalClient);
        expect(libsqlObservation.createClient).toHaveBeenCalledTimes(2);
        reopened.close();
        await settleScheduledClose();
        expect(libsqlObservation.clients[1]?.close).toHaveBeenCalledOnce();
    });

    it('releases a failed owner initialization without closing a surviving store lease', async () => {
        // Given
        const dataDir = await makeTempDataDir('failed-owner');
        const persistentRuntime = await openMissionControlDb({ dataDir });
        const persistentStore = TursoPersistentStore.fromRuntime(persistentRuntime);
        await runLocalLibsqlWrite(persistentRuntime, async (client) => {
            await client.execute('DROP TABLE runtime_agents');
            await client.execute('CREATE VIEW runtime_agents AS SELECT 1 AS invalid');
        });

        // When
        await expect(createSqlTaskRuntimeServices(dataDir, { recoverActiveJobs: false })).rejects.toThrow();
        await settleScheduledClose();

        // Then
        expect(libsqlObservation.createClient).toHaveBeenCalledTimes(1);
        expect(libsqlObservation.clients[0]?.close).not.toHaveBeenCalled();
        await persistentStore.set('survivor', 'task-8', true);
        await runLocalLibsqlWrite(persistentRuntime, async (client) => {
            await client.execute('DROP VIEW runtime_agents');
        });
        const recoveredServices = await createSqlTaskRuntimeServices(dataDir, { recoverActiveJobs: false });
        await recoveredServices.close();
        persistentStore.close();
        await settleScheduledClose();
        expect(libsqlObservation.clients[0]?.close).toHaveBeenCalledOnce();

        const reopened = await openMissionControlDb({ dataDir });
        expect(libsqlObservation.createClient).toHaveBeenCalledTimes(2);
        reopened.close();
    });

    it('releases a session owner store lease when owner construction fails', async () => {
        // Given
        const dataDir = await makeTempDataDir('failed-session-owner');
        const failure = new TypeError('model selection failed');
        const registry = new SessionRunOwnerRegistry({
            dataDir,
            provider: createDeterministicProvider([]),
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            resolveModelProviderSelection: async () => Promise.reject(failure),
        });

        // When
        const opening = registry.status({ sessionId: 'session_failed_owner' });

        // Then
        await expect(opening).rejects.toBe(failure);
        await settleScheduledClose();
        expect(libsqlObservation.createClient).toHaveBeenCalledTimes(1);
        expect(libsqlObservation.clients[0]?.close).toHaveBeenCalledOnce();
        const reopened = await openMissionControlDb({ dataDir });
        expect(libsqlObservation.createClient).toHaveBeenCalledTimes(2);
        reopened.close();
    });
});

async function makeTempDataDir(name: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), `mctrl-task-8-${name}-`));
    tempDirs.push(directory);
    return directory;
}

async function settleScheduledClose(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}
