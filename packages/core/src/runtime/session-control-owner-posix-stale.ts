import type { SessionControlLease } from './session-control-lease';
import { isErrorCode } from '../util/node-error';
import { SessionControlOwnerError } from './session-control-owner-error';
import type { SessionControlProcessState } from './session-control-process';
import { authenticateSessionControlEndpoint, sessionControlNonceHash } from './session-control-registry-auth';
import { readSessionControlRegistry, type SessionControlRegistry } from './session-control-registry-file';
import { lstat, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export async function cleanVerifiedStaleOwner(input: {
    readonly registryPath: string;
    readonly socketPath: string;
    readonly newEpoch: number;
    readonly fallbackLease: SessionControlLease;
    readonly processProbe: (pid: number, processStartId: string) => Promise<SessionControlProcessState>;
}): Promise<void> {
    const registry = await tryReadRegistry(input.registryPath);
    if (registry !== undefined) {
        if (registry.endpoint !== input.socketPath || registry.epoch >= input.newEpoch) {
            throw new SessionControlOwnerError(
                'registry_forged',
                'Stale session control registry does not match its namespace',
            );
        }
        if (registry.epoch === input.fallbackLease.epoch) {
            assertPreviousRegistry(registry, input.fallbackLease);
        }
        if (await authenticateSessionControlEndpoint(registry)) {
            throw new SessionControlOwnerError(
                'stale_owner_still_active',
                'Expired owner endpoint still authenticates',
            );
        }
    }
    const pid = registry?.pid ?? input.fallbackLease.pid;
    const processStartId = registry?.process_start_id ?? input.fallbackLease.processStartId;
    const processState = await input.processProbe(pid, processStartId);
    if (processState !== 'dead' && processState !== 'mismatched') {
        throw new SessionControlOwnerError('stale_owner_still_active', 'Expired owner process is not proven stale');
    }
    await removeSecureStaleSocket(input.socketPath);
    await rm(input.registryPath, { force: true });
    await removeRegistryTemps(input.registryPath);
}

function assertPreviousRegistry(registry: SessionControlRegistry, lease: SessionControlLease): void {
    let nonceHash: string;
    try {
        nonceHash = sessionControlNonceHash(registry.nonce);
    } catch {
        throw new SessionControlOwnerError('registry_forged', 'Stale session control registry is invalid');
    }
    if (
        registry.owner_id !== lease.ownerId ||
        registry.pid !== lease.pid ||
        registry.process_start_id !== lease.processStartId ||
        nonceHash !== lease.nonceHash
    ) {
        throw new SessionControlOwnerError('registry_forged', 'Stale session control registry is invalid');
    }
}

export async function refuseUntrackedArtifacts(registryPath: string, socketPath: string): Promise<void> {
    if ((await pathExists(registryPath)) || (await pathExists(socketPath))) {
        throw new SessionControlOwnerError('registry_forged', 'Untracked session control artifacts already exist');
    }
}

export async function removeOwnedRegistry(registryPath: string, lease: SessionControlLease): Promise<void> {
    const registry = await tryReadRegistry(registryPath);
    if (registry?.owner_id === lease.ownerId && registry.epoch === lease.epoch) {
        await rm(registryPath, { force: true });
    }
}

async function removeSecureStaleSocket(socketPath: string): Promise<void> {
    try {
        const details = await lstat(socketPath);
        if (details.isSymbolicLink() || !details.isSocket() || details.uid !== process.getuid?.()) {
            throw new SessionControlOwnerError('registry_forged', 'Stale endpoint is not a current-user socket');
        }
        await rm(socketPath);
    } catch (error: unknown) {
        if (!isErrorCode(error, 'ENOENT')) throw error;
    }
}

async function removeRegistryTemps(registryPath: string): Promise<void> {
    const prefix = `.${basename(registryPath)}.`;
    const directory = dirname(registryPath);
    const entries = await readdir(directory);
    await Promise.all(
        entries
            .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.tmp'))
            .map((entry) => rm(join(directory, entry), { force: true })),
    );
}

async function tryReadRegistry(registryPath: string): Promise<SessionControlRegistry | undefined> {
    try {
        return await readSessionControlRegistry(registryPath);
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) return undefined;
        throw new SessionControlOwnerError('registry_forged', 'Session control registry is invalid', error);
    }
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) return false;
        throw error;
    }
}


