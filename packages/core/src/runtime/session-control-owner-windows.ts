import type { LocalLibsqlWriteTarget } from '../db/local-libsql-db';
import {
    acquireSessionControlLease,
    expireSessionControlLease,
    renewSessionControlLease,
    type SessionControlLease,
} from './session-control-lease';
import { SessionControlOwnerError } from './session-control-owner-error';
import type { PosixSessionControlOwner } from './session-control-owner-posix';
import {
    assertSessionControlRegistryMatchesLease,
    sessionControlRegistryForLease,
} from './session-control-owner-posix';
import { releaseSessionControlOwnerLease } from './session-control-owner-posix-release';
import { currentSessionControlProcessIdentity, probeSessionControlProcess } from './session-control-process';
import {
    launchWindowsSessionControlProxy,
    resolveWindowsSessionControlPaths,
    type WindowsSessionControlPaths,
    type WindowsSessionControlProxy,
    type WindowsSessionControlProxyBootstrap,
    type WindowsSessionControlProxyLaunchInput,
} from './session-control-proxy-windows';
import {
    authenticateIncomingSessionControlConnection,
    deferAuthenticatedSessionControlConnectionClose,
    generateSessionControlNonce,
    sessionControlNonceHash,
} from './session-control-registry-auth';
import {
    publishSessionControlRegistry,
    readSessionControlRegistry,
    type SessionControlRegistry,
} from './session-control-registry-file';
import { randomBytes } from 'node:crypto';
import { lstat, rm } from 'node:fs/promises';
import type { Duplex } from 'node:stream';

const SIDECAR_ENV_KEY = 'MISSION_CONTROL_SIDECAR';

type PublishWindowsSessionControlOwnerInput = {
    readonly runtime: LocalLibsqlWriteTarget;
    readonly dbIdentity: string;
    readonly sessionId: string;
    readonly ownerId: string;
    readonly onAuthenticated?: (connection: Duplex, initialBytes: Buffer) => void;
    readonly nowWallMs?: number;
    readonly sidecarCommand?: string;
    readonly registryRoot?: string;
    readonly launchProxy?: (input: WindowsSessionControlProxyLaunchInput) => Promise<WindowsSessionControlProxy>;
};

export async function publishWindowsSessionControlOwner(
    input: PublishWindowsSessionControlOwnerInput,
): Promise<PosixSessionControlOwner> {
    const nonce = generateSessionControlNonce();
    const nowWallMs = input.nowWallMs ?? Date.now();
    const processIdentity = await currentSessionControlProcessIdentity();
    const paths = resolveWindowsSessionControlPaths(input.dbIdentity, input.sessionId, input.registryRoot);
    const acquisition = await acquireSessionControlLease({
        runtime: input.runtime,
        dbIdentity: input.dbIdentity,
        sessionId: input.sessionId,
        ownerId: input.ownerId,
        nonceHash: sessionControlNonceHash(nonce),
        pid: processIdentity.pid,
        processStartId: processIdentity.processStartId,
        nowWallMs,
    });
    let proxy: WindowsSessionControlProxy | undefined;
    try {
        await assertWindowsTakeoverIsSafe(paths, acquisition.previous);
        const bootstrap = bootstrapFor(paths, acquisition.lease, nonce);
        proxy = await (input.launchProxy ?? launchWindowsSessionControlProxy)({
            command: input.sidecarCommand ?? process.env[SIDECAR_ENV_KEY] ?? 'mission-control-sidecar',
            bootstrap,
        });
        const registry = await readWindowsRegistry(paths.registryPath);
        assertWindowsRegistry(registry, acquisition.lease, proxy.endpoint);
        proxy.onConnection((connection) => {
            authenticateIncomingSessionControlConnection(connection, {
                nonce,
                ownerId: input.ownerId,
                epoch: acquisition.lease.epoch,
                ...(input.onAuthenticated !== undefined ? { onAuthenticated: input.onAuthenticated } : {}),
            });
        });
    } catch (error: unknown) {
        await proxy?.close().catch(() => undefined);
        await expireSessionControlLease({ runtime: input.runtime, lease: acquisition.lease, nowWallMs }).catch(
            () => undefined,
        );
        throw error;
    }

    const activeProxy = proxy;
    return {
        endpoint: activeProxy.endpoint,
        epoch: acquisition.lease.epoch,
        ownerId: input.ownerId,
        registryPath: paths.registryPath,
        renew: async (renewalWallMs = Date.now()) => {
            const renewed = await renewSessionControlLease({
                runtime: input.runtime,
                lease: acquisition.lease,
                nowWallMs: renewalWallMs,
            });
            if (renewed === undefined) return false;
            await publishSessionControlRegistry(
                paths.registryPath,
                sessionControlRegistryForLease(renewed, nonce, activeProxy.endpoint),
                { syncDirectory: false },
            );
            return true;
        },
        close: async (closeWallMs = Date.now()) => {
            await removeOwnedWindowsRegistry(paths.registryPath, acquisition.lease);
            await releaseSessionControlOwnerLease({
                runtime: input.runtime,
                lease: acquisition.lease,
                nowWallMs: closeWallMs,
            });
            let deferred = false;
            for (const connection of activeProxy.activeConnections()) {
                deferred =
                    deferAuthenticatedSessionControlConnectionClose(connection, () => {
                        void activeProxy.close().catch(() => connection.destroy());
                    }) || deferred;
            }
            if (!deferred) await activeProxy.close();
        },
    };
}

async function assertWindowsTakeoverIsSafe(
    paths: WindowsSessionControlPaths,
    previous: SessionControlLease | undefined,
): Promise<void> {
    if (previous === undefined) {
        try {
            await lstat(paths.registryPath);
        } catch (error: unknown) {
            if (isErrorCode(error, 'ENOENT')) return;
            throw error;
        }
        throw new SessionControlOwnerError('registry_forged', 'Untracked Windows owner registry already exists');
    }
    try {
        const registry = await readWindowsRegistry(paths.registryPath);
        assertSessionControlRegistryMatchesLease(registry, previous, registry.endpoint);
    } catch (error: unknown) {
        if (!isErrorCode(error, 'ENOENT')) throw error;
    }
    const state = await probeSessionControlProcess(previous.pid, previous.processStartId);
    if (state !== 'dead' && state !== 'mismatched') {
        throw new SessionControlOwnerError('stale_owner_still_active', 'Expired Windows owner is not proven stale');
    }
}

function bootstrapFor(
    paths: WindowsSessionControlPaths,
    lease: SessionControlLease,
    nonce: string,
): WindowsSessionControlProxyBootstrap {
    return {
        registry_dir: paths.registryDir,
        registry_path: paths.registryPath,
        nonce,
        pipe_random: randomBytes(16).toString('base64url'),
        owner_id: lease.ownerId,
        epoch: lease.epoch,
        pid: lease.pid,
        process_start_id: lease.processStartId,
        heartbeat_wall_ms: lease.heartbeatWallMs,
        expires_wall_ms: lease.expiresWallMs,
    };
}

async function readWindowsRegistry(registryPath: string): Promise<SessionControlRegistry> {
    return readSessionControlRegistry(registryPath, { verifyPosixMetadata: false });
}

function assertWindowsRegistry(registry: SessionControlRegistry, lease: SessionControlLease, endpoint: string): void {
    if (!endpoint.startsWith('\\\\.\\pipe\\mission-control-')) {
        throw new SessionControlOwnerError('registry_forged', 'Windows owner registry endpoint is invalid');
    }
    assertSessionControlRegistryMatchesLease(registry, lease, endpoint);
}

async function removeOwnedWindowsRegistry(registryPath: string, lease: SessionControlLease): Promise<void> {
    try {
        const registry = await readWindowsRegistry(registryPath);
        if (registry.owner_id === lease.ownerId && registry.epoch === lease.epoch) {
            await rm(registryPath, { force: true });
        }
    } catch (error: unknown) {
        if (!isErrorCode(error, 'ENOENT')) throw error;
    }
}

function isErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
