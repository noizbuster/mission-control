import { afterEach, describe, expect, it } from 'vitest';
import { openLocalLibsqlDb } from '../db/local-libsql-db.js';
import { readSessionControlLease } from './session-control-lease.js';
import {
    publishPosixSessionControlOwner,
    resolveAuthenticatedPosixSessionControlOwner,
    SessionControlOwnerError,
} from './session-control-owner-posix.js';
import { generateSessionControlNonce } from './session-control-registry-auth.js';
import { publishSessionControlRegistry, readSessionControlRegistry } from './session-control-registry-file.js';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB_IDENTITY = '5'.repeat(64);
const SESSION_ID = 'forgery-session';
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

describe.runIf(process.platform !== 'win32')('POSIX owner registry forgery resistance', () => {
    it('rejects a forged nonce, forged owner, and old epoch without leaking the nonce', async () => {
        const runtimeDir = await createDirectory('mctrl-control-forgery-runtime-');
        const dataDir = await createDirectory('mctrl-control-forgery-db-');
        const runtime = await openLocalLibsqlDb({ url: `file:${join(dataDir, 'mission-control.db')}` });
        const owner = await publishPosixSessionControlOwner({
            runtime,
            dbIdentity: DB_IDENTITY,
            sessionId: SESSION_ID,
            ownerId: 'owner-one',
            nowWallMs: 1_000,
            processIdentity: { pid: process.pid, processStartId: 'process-one' },
            paths: { xdgRuntimeDir: runtimeDir },
        });
        const registry = await readSessionControlRegistry(owner.registryPath);
        const forgedNonce = generateSessionControlNonce();
        await publishSessionControlRegistry(owner.registryPath, { ...registry, nonce: forgedNonce });

        const nonceFailure = resolveAuthenticatedPosixSessionControlOwner({
            runtime,
            dbIdentity: DB_IDENTITY,
            sessionId: SESSION_ID,
            nowWallMs: 2_000,
            paths: { xdgRuntimeDir: runtimeDir },
        });
        await expect(nonceFailure).rejects.toMatchObject({
            code: 'registry_forged',
        } satisfies Partial<SessionControlOwnerError>);
        await expect(nonceFailure).rejects.not.toThrow(forgedNonce);

        await publishSessionControlRegistry(owner.registryPath, { ...registry, owner_id: 'forged-owner' });
        await expect(
            resolveAuthenticatedPosixSessionControlOwner({
                runtime,
                dbIdentity: DB_IDENTITY,
                sessionId: SESSION_ID,
                nowWallMs: 2_000,
                paths: { xdgRuntimeDir: runtimeDir },
            }),
        ).rejects.toMatchObject({ code: 'registry_forged' });

        await publishSessionControlRegistry(owner.registryPath, registry);
        await owner.close(2_000);
        const replacement = await publishPosixSessionControlOwner({
            runtime,
            dbIdentity: DB_IDENTITY,
            sessionId: SESSION_ID,
            ownerId: 'owner-two',
            nowWallMs: 2_000,
            processIdentity: { pid: process.pid, processStartId: 'process-two' },
            processProbe: async () => 'mismatched',
            paths: { xdgRuntimeDir: runtimeDir },
        });
        const replacementRegistry = await readSessionControlRegistry(replacement.registryPath);
        await publishSessionControlRegistry(replacement.registryPath, { ...replacementRegistry, epoch: 1 });

        await expect(
            resolveAuthenticatedPosixSessionControlOwner({
                runtime,
                dbIdentity: DB_IDENTITY,
                sessionId: SESSION_ID,
                nowWallMs: 2_001,
                paths: { xdgRuntimeDir: runtimeDir },
            }),
        ).rejects.toMatchObject({ code: 'registry_forged' });
        expect(await readSessionControlLease(runtime, DB_IDENTITY, SESSION_ID)).toMatchObject({ epoch: 2 });

        await replacement.close(2_001);
        runtime.close();
    });
});
