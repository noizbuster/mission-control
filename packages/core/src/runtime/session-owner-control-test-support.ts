import { openLocalLibsqlDb } from '../db/local-libsql-db';
import { openLocalSessionEventStore } from '../memory/local-session-store';
import { SessionControlHost } from './session-control-host';
import { resolvePosixSessionControlPaths } from './session-control-registry-paths';
import { createPosixSessionOwnerControlClient } from './session-owner-control-client';
import { resolveSessionStoreIdentity } from './session-store-identity';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directories: string[] = [];

export async function cleanupSessionOwnerControlFixtures(): Promise<void> {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}

export async function createSessionOwnerControlFixture(
    sessionId: string,
    retainAttachment = false,
    ownerControlDeadline?: ConstructorParameters<typeof SessionControlHost>[0]['ownerControlDeadline'],
) {
    const dataDir = await createDirectory('mctrl-owner-ipc-data-');
    const runtimeDir = await createDirectory('mctrl-owner-ipc-runtime-');
    const identity = await resolveSessionStoreIdentity({ dataDir });
    const store = await openLocalSessionEventStore({ dataDir, sessionId });
    await store.append({ type: 'session.started', timestamp: new Date().toISOString(), sessionId });
    const runtime = await openLocalLibsqlDb({ url: identity.databaseFileUrl });
    const ownerPaths = { xdgRuntimeDir: runtimeDir };
    const host = new SessionControlHost({
        runtime,
        dbIdentity: identity.dbIdentity,
        dataDir,
        ownerPaths,
        ...(ownerControlDeadline !== undefined ? { ownerControlDeadline } : {}),
    });
    if (retainAttachment) {
        await host.attachEntity({ sessionId, kind: 'run', entityId: 'retained-run', handles: [] });
    } else {
        await host.acquire(sessionId);
    }
    return {
        sessionId,
        dbIdentity: identity.dbIdentity,
        runtime,
        store,
        host,
        paths: () => resolvePosixSessionControlPaths({ dbIdentity: identity.dbIdentity, sessionId, ...ownerPaths }),
        client: () =>
            createPosixSessionOwnerControlClient({
                runtime,
                dbIdentity: identity.dbIdentity,
                sessionId,
                paths: ownerPaths,
            }),
        close: async (closeHost = true) => {
            if (closeHost) await host.close();
            await store.close();
            runtime.close();
        },
    };
}

export function wait(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function waitFor(check: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (await check()) return;
        await wait(5);
    }
    throw new Error('condition did not settle');
}

async function createDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    directories.push(directory);
    await chmod(directory, 0o700);
    return directory;
}
