import type { LocalLibsqlWriteTarget } from '../db/local-libsql-db.js';
import { SessionControlOwnerError } from './session-control-owner-error.js';

export { SessionControlOwnerError } from './session-control-owner-error.js';

import {
    acquireSessionControlLease,
    expireSessionControlLease,
    readSessionControlLease,
    renewSessionControlLease,
    type SessionControlLease,
} from './session-control-lease.js';
import { releaseSessionControlOwnerLease } from './session-control-owner-posix-release.js';
import {
    cleanVerifiedStaleOwner,
    refuseUntrackedArtifacts,
    removeOwnedRegistry,
} from './session-control-owner-posix-stale.js';
import {
    currentSessionControlProcessIdentity,
    probeSessionControlProcess,
    type SessionControlProcessIdentity,
    type SessionControlProcessState,
} from './session-control-process.js';
import {
    type AuthenticatedSessionControlServer,
    authenticateSessionControlEndpoint,
    createAuthenticatedSessionControlServer,
    generateSessionControlNonce,
    sessionControlNonceHash,
} from './session-control-registry-auth.js';
import {
    publishSessionControlRegistry,
    readSessionControlRegistry,
    type SessionControlRegistry,
} from './session-control-registry-file.js';
import {
    type ResolvePosixSessionControlPathsInput,
    resolvePosixSessionControlPaths,
} from './session-control-registry-paths.js';
import type { Duplex } from 'node:stream';

export type PosixSessionControlOwner = {
    readonly endpoint: string;
    readonly epoch: number;
    readonly ownerId: string;
    readonly registryPath: string;
    readonly renew: (nowWallMs?: number) => Promise<boolean>;
    readonly close: (nowWallMs?: number) => Promise<void>;
};

type PublishPosixSessionControlOwnerInput = {
    readonly runtime: LocalLibsqlWriteTarget;
    readonly dbIdentity: string;
    readonly sessionId: string;
    readonly ownerId: string;
    readonly nowWallMs?: number;
    readonly processIdentity?: SessionControlProcessIdentity;
    readonly processProbe?: (pid: number, processStartId: string) => Promise<SessionControlProcessState>;
    readonly paths?: Omit<ResolvePosixSessionControlPathsInput, 'dbIdentity' | 'sessionId'>;
    readonly onAuthenticated?: (connection: Duplex, initialBytes: Buffer) => void;
};

export async function publishPosixSessionControlOwner(
    input: PublishPosixSessionControlOwnerInput,
): Promise<PosixSessionControlOwner> {
    const nonce = generateSessionControlNonce();
    const nowWallMs = input.nowWallMs ?? Date.now();
    const processIdentity = input.processIdentity ?? (await currentSessionControlProcessIdentity());
    const paths = await resolvePosixSessionControlPaths({
        dbIdentity: input.dbIdentity,
        sessionId: input.sessionId,
        ...input.paths,
    });
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
    let server: AuthenticatedSessionControlServer | undefined;
    try {
        if (acquisition.previous === undefined) {
            await refuseUntrackedArtifacts(paths.registryPath, paths.socketPath);
        } else {
            await cleanVerifiedStaleOwner({
                registryPath: paths.registryPath,
                socketPath: paths.socketPath,
                newEpoch: acquisition.lease.epoch,
                fallbackLease: acquisition.previous,
                processProbe: input.processProbe ?? probeSessionControlProcess,
            });
        }
        server = await createAuthenticatedSessionControlServer({
            socketPath: paths.socketPath,
            nonce,
            ownerId: input.ownerId,
            epoch: acquisition.lease.epoch,
            ...(input.onAuthenticated !== undefined ? { onAuthenticated: input.onAuthenticated } : {}),
        });
        await publishSessionControlRegistry(
            paths.registryPath,
            sessionControlRegistryForLease(acquisition.lease, nonce, paths.socketPath),
        );
    } catch (error: unknown) {
        await server?.close().catch(() => undefined);
        await expireSessionControlLease({ runtime: input.runtime, lease: acquisition.lease, nowWallMs }).catch(
            () => undefined,
        );
        throw error;
    }

    const activeServer = server;
    return {
        endpoint: paths.socketPath,
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
                sessionControlRegistryForLease(renewed, nonce, paths.socketPath),
            );
            return true;
        },
        close: async (closeWallMs = Date.now()) => {
            await activeServer.close();
            await removeOwnedRegistry(paths.registryPath, acquisition.lease);
            await releaseSessionControlOwnerLease({
                runtime: input.runtime,
                lease: acquisition.lease,
                nowWallMs: closeWallMs,
            });
        },
    };
}

export async function resolveAuthenticatedPosixSessionControlOwner(input: {
    readonly runtime: LocalLibsqlWriteTarget;
    readonly dbIdentity: string;
    readonly sessionId: string;
    readonly nowWallMs?: number;
    readonly authenticateEndpoint?: boolean;
    readonly paths?: Omit<ResolvePosixSessionControlPathsInput, 'dbIdentity' | 'sessionId'>;
}): Promise<{ readonly endpoint: string; readonly ownerId: string; readonly epoch: number }> {
    const nowWallMs = input.nowWallMs ?? Date.now();
    const lease = await readSessionControlLease(input.runtime, input.dbIdentity, input.sessionId);
    if (lease === undefined || lease.expiresWallMs <= nowWallMs) {
        throw new SessionControlOwnerError('owner_unreachable', 'No live session control owner is registered');
    }
    const paths = await resolvePosixSessionControlPaths({
        dbIdentity: input.dbIdentity,
        sessionId: input.sessionId,
        ...input.paths,
    });
    const registry = await readRegistryOrThrow(paths.registryPath);
    assertSessionControlRegistryMatchesLease(registry, lease, paths.socketPath);
    if ((input.authenticateEndpoint ?? true) && !(await authenticateSessionControlEndpoint(registry))) {
        throw new SessionControlOwnerError('authentication_failed', 'The session control owner did not authenticate');
    }
    return { endpoint: registry.endpoint, ownerId: registry.owner_id, epoch: registry.epoch };
}

export function sessionControlRegistryForLease(
    lease: SessionControlLease,
    nonce: string,
    endpoint: string,
): SessionControlRegistry {
    return {
        endpoint,
        nonce,
        owner_id: lease.ownerId,
        epoch: lease.epoch,
        pid: lease.pid,
        process_start_id: lease.processStartId,
        heartbeat_wall_ms: lease.heartbeatWallMs,
        expires_wall_ms: lease.expiresWallMs,
    };
}

export function assertSessionControlRegistryMatchesLease(
    registry: SessionControlRegistry,
    lease: SessionControlLease,
    endpoint: string,
): void {
    let nonceHash: string;
    try {
        nonceHash = sessionControlNonceHash(registry.nonce);
    } catch {
        throw new SessionControlOwnerError('registry_forged', 'Session control registry does not match the DB lease');
    }
    if (
        registry.endpoint !== endpoint ||
        registry.owner_id !== lease.ownerId ||
        registry.epoch !== lease.epoch ||
        registry.pid !== lease.pid ||
        registry.process_start_id !== lease.processStartId ||
        registry.heartbeat_wall_ms !== lease.heartbeatWallMs ||
        registry.expires_wall_ms !== lease.expiresWallMs ||
        nonceHash !== lease.nonceHash
    ) {
        throw new SessionControlOwnerError('registry_forged', 'Session control registry does not match the DB lease');
    }
}

async function readRegistryOrThrow(registryPath: string): Promise<SessionControlRegistry> {
    try {
        return await readSessionControlRegistry(registryPath);
    } catch (error: unknown) {
        throw new SessionControlOwnerError(
            'registry_forged',
            'Session control registry is unavailable or invalid',
            error,
        );
    }
}
