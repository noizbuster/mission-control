import { afterEach, describe, expect, it } from 'vitest';
import { type LocalLibsqlDb, openLocalLibsqlDb } from '../db/local-libsql-db';
import { acquireSessionControlLease } from './session-control-lease';
import {
    publishPosixSessionControlOwner,
    resolveAuthenticatedPosixSessionControlOwner,
} from './session-control-owner-posix';
import {
    createAuthenticatedSessionControlServer,
    generateSessionControlNonce,
    sessionControlNonceHash,
} from './session-control-registry-auth';
import { publishSessionControlRegistry, readSessionControlRegistry } from './session-control-registry-file';
import { resolvePosixSessionControlPaths } from './session-control-registry-paths';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SESSION_ID = 'owner-session';
const tempDirs: string[] = [];

async function createDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(directory);
    await chmod(directory, 0o700);
    return directory;
}

async function createRuntime(): Promise<LocalLibsqlDb> {
    const directory = await createDirectory('mctrl-control-owner-db-');
    return openLocalLibsqlDb({ url: `file:${join(directory, 'mission-control.db')}` });
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe.runIf(process.platform !== 'win32')('POSIX exclusive session control owner', () => {
    it('publishes and resolves authenticated owners independently by DB identity', async () => {
        const runtimeDir = await createDirectory('mctrl-control-owner-runtime-');
        const firstRuntime = await createRuntime();
        const secondRuntime = await createRuntime();
        const firstDbIdentity = '1'.repeat(64);
        const secondDbIdentity = '2'.repeat(64);

        const first = await publishPosixSessionControlOwner({
            runtime: firstRuntime,
            dbIdentity: firstDbIdentity,
            sessionId: SESSION_ID,
            ownerId: 'owner-one',
            nowWallMs: 1_000,
            processIdentity: { pid: process.pid, processStartId: 'process-one' },
            paths: { xdgRuntimeDir: runtimeDir },
        });
        const second = await publishPosixSessionControlOwner({
            runtime: secondRuntime,
            dbIdentity: secondDbIdentity,
            sessionId: SESSION_ID,
            ownerId: 'owner-two',
            nowWallMs: 1_000,
            processIdentity: { pid: process.pid, processStartId: 'process-two' },
            paths: { xdgRuntimeDir: runtimeDir },
        });

        await expect(
            resolveAuthenticatedPosixSessionControlOwner({
                runtime: firstRuntime,
                dbIdentity: firstDbIdentity,
                sessionId: SESSION_ID,
                nowWallMs: 2_000,
                paths: { xdgRuntimeDir: runtimeDir },
            }),
        ).resolves.toMatchObject({ ownerId: 'owner-one', epoch: 1 });
        await expect(
            resolveAuthenticatedPosixSessionControlOwner({
                runtime: secondRuntime,
                dbIdentity: secondDbIdentity,
                sessionId: SESSION_ID,
                nowWallMs: 2_000,
                paths: { xdgRuntimeDir: runtimeDir },
            }),
        ).resolves.toMatchObject({ ownerId: 'owner-two', epoch: 1 });
        expect(first.endpoint).not.toBe(second.endpoint);

        await first.close(2_000);
        await second.close(2_000);
        firstRuntime.close();
        secondRuntime.close();
    });

    it('refuses a second live owner without replacing the registry', async () => {
        const runtimeDir = await createDirectory('mctrl-control-live-runtime-');
        const runtime = await createRuntime();
        const dbIdentity = '3'.repeat(64);
        const owner = await publishPosixSessionControlOwner({
            runtime,
            dbIdentity,
            sessionId: SESSION_ID,
            ownerId: 'owner-one',
            nowWallMs: 1_000,
            processIdentity: { pid: process.pid, processStartId: 'process-one' },
            paths: { xdgRuntimeDir: runtimeDir },
        });
        const before = await readSessionControlRegistry(owner.registryPath);

        await expect(
            publishPosixSessionControlOwner({
                runtime,
                dbIdentity,
                sessionId: SESSION_ID,
                ownerId: 'owner-two',
                nowWallMs: 2_000,
                processIdentity: { pid: process.pid, processStartId: 'process-two' },
                paths: { xdgRuntimeDir: runtimeDir },
            }),
        ).rejects.toMatchObject({ code: 'session_owned_elsewhere' });
        expect(await readSessionControlRegistry(owner.registryPath)).toEqual(before);

        await owner.close(2_000);
        runtime.close();
    });

    it('publishes a new same-process owner after the previous owner closes normally', async () => {
        const runtimeDir = await createDirectory('mctrl-control-sequential-runtime-');
        const runtime = await createRuntime();
        const dbIdentity = '7'.repeat(64);
        const first = await publishPosixSessionControlOwner({
            runtime,
            dbIdentity,
            sessionId: SESSION_ID,
            ownerId: 'owner-first',
            paths: { xdgRuntimeDir: runtimeDir },
        });

        await first.close();
        const second = await publishPosixSessionControlOwner({
            runtime,
            dbIdentity,
            sessionId: SESSION_ID,
            ownerId: 'owner-second',
            paths: { xdgRuntimeDir: runtimeDir },
        });

        expect(second.epoch).toBe(2);
        await expect(
            resolveAuthenticatedPosixSessionControlOwner({
                runtime,
                dbIdentity,
                sessionId: SESSION_ID,
                paths: { xdgRuntimeDir: runtimeDir },
            }),
        ).resolves.toMatchObject({ ownerId: 'owner-second', epoch: 2 });
        await second.close();
        runtime.close();
    });

    it('takes over only after DB epoch wins, old auth fails, and the old process is stale', async () => {
        const runtimeDir = await createDirectory('mctrl-control-stale-runtime-');
        const runtime = await createRuntime();
        const dbIdentity = '4'.repeat(64);
        const nonce = generateSessionControlNonce();
        const oldLease = (
            await acquireSessionControlLease({
                runtime,
                dbIdentity,
                sessionId: SESSION_ID,
                ownerId: 'owner-old',
                nonceHash: sessionControlNonceHash(nonce),
                pid: 404_404,
                processStartId: 'old-process',
                nowWallMs: 1_000,
            })
        ).lease;
        const paths = await resolvePosixSessionControlPaths({
            dbIdentity,
            sessionId: SESSION_ID,
            xdgRuntimeDir: runtimeDir,
        });
        const oldServer = await createAuthenticatedSessionControlServer({
            socketPath: paths.socketPath,
            nonce,
            ownerId: oldLease.ownerId,
            epoch: oldLease.epoch,
        });
        await publishSessionControlRegistry(paths.registryPath, {
            endpoint: paths.socketPath,
            nonce,
            owner_id: oldLease.ownerId,
            epoch: oldLease.epoch,
            pid: oldLease.pid,
            process_start_id: oldLease.processStartId,
            heartbeat_wall_ms: oldLease.heartbeatWallMs,
            expires_wall_ms: oldLease.expiresWallMs,
        });
        await oldServer.close();

        const owner = await publishPosixSessionControlOwner({
            runtime,
            dbIdentity,
            sessionId: SESSION_ID,
            ownerId: 'owner-new',
            nowWallMs: 16_000,
            processIdentity: { pid: process.pid, processStartId: 'new-process' },
            processProbe: async () => 'dead',
            paths: { xdgRuntimeDir: runtimeDir },
        });

        expect(owner.epoch).toBe(2);
        await expect(
            resolveAuthenticatedPosixSessionControlOwner({
                runtime,
                dbIdentity,
                sessionId: SESSION_ID,
                nowWallMs: 16_001,
                paths: { xdgRuntimeDir: runtimeDir },
            }),
        ).resolves.toMatchObject({ ownerId: 'owner-new', epoch: 2 });
        await owner.close(16_001);
        runtime.close();
    });
});
