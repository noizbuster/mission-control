import type { SessionStopScope } from '@mission-control/protocol';
import { resolveMissionControlDataDir } from '../memory/data-dir';
import { openCanonicalRuntimeDb } from './local-runtime-db';
import { SessionControlLeaseError } from './session-control-lease';
import { SessionControlHost } from './session-control-host';
import {
    createPlatformSessionOwnerControlClient,
    SessionOwnerControlClientError,
    type SessionOwnerControlClient,
} from './session-owner-control-client';
import { type SessionStopTreeResult, stopSessionTree } from './session-stop-tree';
import { setTimeout as delay } from 'node:timers/promises';

const OWNER_PUBLICATION_RETRY_DELAY_MS = 10;
const OWNER_PUBLICATION_RETRY_WINDOW_MS = 250;

export type StopLocalSessionTreeInput = {
    readonly targetSessionId: string;
    readonly scope: SessionStopScope;
    readonly requestId: string;
    readonly operationId: string;
    readonly timeoutMs: number;
    readonly dataDir?: string;
};

export async function stopLocalSessionTree(input: StopLocalSessionTreeInput): Promise<SessionStopTreeResult> {
    const dataDir = input.dataDir ?? resolveMissionControlDataDir();
    const { identity, runtime } = await openCanonicalRuntimeDb({
        dataDir,
        sessionControlMaintenance: false,
    });
    const host = new SessionControlHost({ runtime, dbIdentity: identity.dbIdentity, dataDir });
    const ownerDiscoveryDeadlineMs = Date.now() + Math.min(input.timeoutMs, OWNER_PUBLICATION_RETRY_WINDOW_MS);
    try {
        return await stopSessionTree({
            targetSessionId: input.targetSessionId,
            scope: input.scope,
            requestId: input.requestId,
            operationId: input.operationId,
            timeoutMs: input.timeoutMs,
            client: runtime.client,
            createClient: (sessionId) =>
                createRecoveringSessionOwnerControlClient({
                    host,
                    runtime,
                    dbIdentity: identity.dbIdentity,
                    sessionId,
                    ownerDiscoveryDeadlineMs,
                }),
        });
    } finally {
        await host.close();
        runtime.close();
    }
}

async function createRecoveringSessionOwnerControlClient(input: {
    readonly host: SessionControlHost;
    readonly runtime: Awaited<ReturnType<typeof openCanonicalRuntimeDb>>['runtime'];
    readonly dbIdentity: string;
    readonly sessionId: string;
    readonly ownerDiscoveryDeadlineMs?: number;
}): Promise<SessionOwnerControlClient> {
    try {
        return await createPlatformSessionOwnerControlClient({
            runtime: input.runtime,
            dbIdentity: input.dbIdentity,
            sessionId: input.sessionId,
        });
    } catch (error: unknown) {
        if (!(error instanceof SessionOwnerControlClientError) || error.code !== 'ownerless') {
            throw error;
        }
    }
    try {
        await input.host.acquire(input.sessionId);
    } catch (error: unknown) {
        if (!(error instanceof SessionControlLeaseError) || error.code !== 'session_owned_elsewhere') {
            throw error;
        }
        return waitForWinningOwnerPublication({
            ...input,
            ownerDiscoveryDeadlineMs: input.ownerDiscoveryDeadlineMs ?? Date.now() + OWNER_PUBLICATION_RETRY_WINDOW_MS,
        });
    }
    return createPlatformSessionOwnerControlClient({
        runtime: input.runtime,
        dbIdentity: input.dbIdentity,
        sessionId: input.sessionId,
    });
}

async function waitForWinningOwnerPublication(input: {
    readonly host: SessionControlHost;
    readonly runtime: Awaited<ReturnType<typeof openCanonicalRuntimeDb>>['runtime'];
    readonly dbIdentity: string;
    readonly sessionId: string;
    readonly ownerDiscoveryDeadlineMs: number;
}): Promise<SessionOwnerControlClient> {
    try {
        return await retrySessionOwnerControlClientDiscovery({
            createClient: () =>
                createPlatformSessionOwnerControlClient({
                    runtime: input.runtime,
                    dbIdentity: input.dbIdentity,
                    sessionId: input.sessionId,
                }),
            deadlineMs: input.ownerDiscoveryDeadlineMs,
        });
    } catch (error: unknown) {
        if (!(error instanceof SessionOwnerControlClientError) || error.code !== 'ownerless') {
            throw error;
        }
        return createRecoveringSessionOwnerControlClient(input);
    }
}

export async function retrySessionOwnerControlClientDiscovery<Client>(input: {
    readonly createClient: () => Promise<Client>;
    readonly deadlineMs: number;
    readonly now?: () => number;
    readonly wait?: (delayMs: number) => Promise<void>;
}): Promise<Client> {
    const now = input.now ?? Date.now;
    const wait = input.wait ?? delay;
    let lastError: SessionOwnerControlClientError | undefined;
    while (now() < input.deadlineMs) {
        try {
            return await input.createClient();
        } catch (error: unknown) {
            if (!isOwnerPublicationError(error)) {
                throw error;
            }
            lastError = error;
        }
        const remaining = input.deadlineMs - now();
        if (remaining <= 0) break;
        await wait(Math.min(OWNER_PUBLICATION_RETRY_DELAY_MS, remaining));
    }
    throw lastError ?? new SessionOwnerControlClientError('owner_unreachable', 'owner registry publication timed out');
}

function isOwnerPublicationError(error: unknown): error is SessionOwnerControlClientError {
    return (
        error instanceof SessionOwnerControlClientError &&
        (error.code === 'authentication_failed' || error.code === 'owner_unreachable')
    );
}
