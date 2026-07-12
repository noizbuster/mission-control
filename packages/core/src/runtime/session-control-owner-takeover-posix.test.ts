import { afterEach, describe, expect, it } from 'vitest';
import { openLocalLibsqlDb } from '../db/local-libsql-db.js';
import {
    acquireSessionControlLease,
    runWithSessionControlLeaseFence,
    SessionControlLeaseError,
} from './session-control-lease.js';
import {
    publishPosixSessionControlOwner,
    resolveAuthenticatedPosixSessionControlOwner,
} from './session-control-owner-posix.js';
import {
    authenticateSessionControlEndpoint,
    generateSessionControlNonce,
    sessionControlNonceHash,
} from './session-control-registry-auth.js';
import { publishSessionControlRegistry } from './session-control-registry-file.js';
import { resolvePosixSessionControlPaths } from './session-control-registry-paths.js';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB_IDENTITY = '6'.repeat(64);
const SESSION_ID = 'resumed-stale-owner';
const tempDirs: string[] = [];

async function createDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(directory);
    await chmod(directory, 0o700);
    return directory;
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe.runIf(process.platform !== 'win32')('POSIX stale owner takeover fencing', () => {
    it('rejects a resumed old epoch after endpoint timeout and process-start mismatch', async () => {
        const runtimeDir = await createDirectory('mctrl-control-takeover-runtime-');
        const dataDir = await createDirectory('mctrl-control-takeover-db-');
        const runtime = await openLocalLibsqlDb({ url: `file:${join(dataDir, 'mission-control.db')}` });
        const nonce = generateSessionControlNonce();
        const oldLease = (
            await acquireSessionControlLease({
                runtime,
                dbIdentity: DB_IDENTITY,
                sessionId: SESSION_ID,
                ownerId: 'owner-suspended',
                nonceHash: sessionControlNonceHash(nonce),
                pid: 606_606,
                processStartId: 'old-process-start',
                nowWallMs: 1_000,
            })
        ).lease;
        const paths = await resolvePosixSessionControlPaths({
            dbIdentity: DB_IDENTITY,
            sessionId: SESSION_ID,
            xdgRuntimeDir: runtimeDir,
        });
        const staleServer = createServer((socket) => socket.resume());
        await new Promise<void>((resolve, reject) => {
            staleServer.once('error', reject);
            staleServer.listen(paths.socketPath, resolve);
        });
        await chmod(paths.socketPath, 0o600);
        const staleRegistry = {
            endpoint: paths.socketPath,
            nonce,
            owner_id: oldLease.ownerId,
            epoch: oldLease.epoch,
            pid: oldLease.pid,
            process_start_id: oldLease.processStartId,
            heartbeat_wall_ms: oldLease.heartbeatWallMs,
            expires_wall_ms: oldLease.expiresWallMs,
        } as const;
        await publishSessionControlRegistry(paths.registryPath, staleRegistry);

        const replacement = await publishPosixSessionControlOwner({
            runtime,
            dbIdentity: DB_IDENTITY,
            sessionId: SESSION_ID,
            ownerId: 'owner-replacement',
            nowWallMs: 16_000,
            processIdentity: { pid: process.pid, processStartId: 'replacement-process-start' },
            processProbe: async () => 'mismatched',
            paths: { xdgRuntimeDir: runtimeDir },
        });

        await expect(authenticateSessionControlEndpoint(staleRegistry)).resolves.toBe(false);
        await expect(
            runWithSessionControlLeaseFence({
                runtime,
                lease: oldLease,
                nowWallMs: 16_001,
                write: (client) => client.execute('SELECT 1'),
            }),
        ).rejects.toMatchObject({ code: 'lease_fenced' } satisfies Partial<SessionControlLeaseError>);
        await expect(
            resolveAuthenticatedPosixSessionControlOwner({
                runtime,
                dbIdentity: DB_IDENTITY,
                sessionId: SESSION_ID,
                nowWallMs: 16_001,
                paths: { xdgRuntimeDir: runtimeDir },
            }),
        ).resolves.toMatchObject({ ownerId: 'owner-replacement', epoch: 2 });

        await replacement.close(16_001);
        await new Promise<void>((resolve, reject) => staleServer.close((error) => (error ? reject(error) : resolve())));
        runtime.close();
    });
});
