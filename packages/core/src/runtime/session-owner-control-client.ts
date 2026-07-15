import {
    SESSION_OWNER_CONTROL_PROTOCOL_VERSION,
    SessionOwnerControlAcquireResultSchema,
    type SessionOwnerControlErrorCode,
    SessionOwnerControlReleaseResultSchema,
    SessionOwnerControlResponseSchema,
    type SessionOwnerControlToken,
    SessionOwnerControlTokenSchema,
    type SessionStopBarrierKind,
    type SessionStopReceiptContract,
    SessionStopReceiptSchema,
} from '@mission-control/protocol';
import type { LocalLibsqlWriteTarget } from '../db/local-libsql-db';
import { readSessionControlLease } from './session-control-lease';
import {
    assertSessionControlRegistryMatchesLease,
    resolveAuthenticatedPosixSessionControlOwner,
    SessionControlOwnerError,
} from './session-control-owner-posix';
import { sessionControlTransportForPlatform } from './session-control-platform';
import { resolveWindowsSessionControlPaths } from './session-control-proxy-windows';
import type { SessionControlRegistry } from './session-control-registry-file';
import { readSessionControlRegistry } from './session-control-registry-file';
import {
    type ResolvePosixSessionControlPathsInput,
    resolvePosixSessionControlPaths,
} from './session-control-registry-paths';
import {
    attachSessionOwnerControlFrameReader,
    encodeSessionOwnerControlFrame,
    parseSessionOwnerControlFrame,
} from './session-owner-control-framing';
import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';

const REQUEST_TIMEOUT_MS = 2_000;

export type SessionOwnerControlClient = {
    readonly acquire: (input: {
        readonly sessionId: string;
        readonly requestId: string;
        readonly operationId: string;
        readonly kind: 'exact_session_stop';
        readonly barrierKind?: SessionStopBarrierKind;
        readonly timeoutMs: number;
    }) => Promise<{ readonly token: SessionOwnerControlToken }>;
    readonly stop: (token: SessionOwnerControlToken) => Promise<SessionStopReceiptContract>;
    readonly release: (token: SessionOwnerControlToken) => Promise<{ readonly released: boolean }>;
};

export class SessionOwnerControlClientError extends Error {
    readonly code: SessionOwnerControlErrorCode;

    constructor(code: SessionOwnerControlErrorCode, message: string, cause?: unknown) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'SessionOwnerControlClientError';
        this.code = code;
    }
}

export async function createPosixSessionOwnerControlClient(input: {
    readonly runtime: LocalLibsqlWriteTarget;
    readonly dbIdentity: string;
    readonly sessionId: string;
    readonly paths?: Omit<ResolvePosixSessionControlPathsInput, 'dbIdentity' | 'sessionId'>;
}): Promise<SessionOwnerControlClient> {
    const lease = await readSessionControlLease(input.runtime, input.dbIdentity, input.sessionId);
    if (lease === undefined || lease.expiresWallMs <= Date.now()) {
        throw new SessionOwnerControlClientError('ownerless', 'no live session owner is registered');
    }
    try {
        await resolveAuthenticatedPosixSessionControlOwner({ ...input, authenticateEndpoint: false });
        const paths = await resolvePosixSessionControlPaths({
            dbIdentity: input.dbIdentity,
            sessionId: input.sessionId,
            ...input.paths,
        });
        return createSessionOwnerControlClient(await readSessionControlRegistry(paths.registryPath));
    } catch (error: unknown) {
        if (
            error instanceof SessionControlOwnerError &&
            (error.code === 'authentication_failed' || error.code === 'registry_forged')
        ) {
            throw new SessionOwnerControlClientError('authentication_failed', 'session owner authentication failed');
        }
        throw new SessionOwnerControlClientError('owner_unreachable', 'session owner endpoint is unreachable', error);
    }
}

export async function createPlatformSessionOwnerControlClient(input: {
    readonly runtime: LocalLibsqlWriteTarget;
    readonly dbIdentity: string;
    readonly sessionId: string;
    readonly paths?: Omit<ResolvePosixSessionControlPathsInput, 'dbIdentity' | 'sessionId'>;
}): Promise<SessionOwnerControlClient> {
    if (sessionControlTransportForPlatform(process.platform) === 'posix_socket') {
        return createPosixSessionOwnerControlClient(input);
    }
    const lease = await readSessionControlLease(input.runtime, input.dbIdentity, input.sessionId);
    if (lease === undefined || lease.expiresWallMs <= Date.now()) {
        throw new SessionOwnerControlClientError('ownerless', 'no live session owner is registered');
    }
    try {
        const paths = resolveWindowsSessionControlPaths(input.dbIdentity, input.sessionId);
        const registry = await readSessionControlRegistry(paths.registryPath, { verifyPosixMetadata: false });
        if (!registry.endpoint.startsWith('\\\\.\\pipe\\mission-control-')) {
            throw new SessionControlOwnerError('registry_forged', 'Windows owner registry endpoint is invalid');
        }
        assertSessionControlRegistryMatchesLease(registry, lease, registry.endpoint);
        return createSessionOwnerControlClient(registry);
    } catch (error: unknown) {
        if (error instanceof SessionControlOwnerError) {
            throw new SessionOwnerControlClientError('authentication_failed', 'session owner authentication failed');
        }
        throw new SessionOwnerControlClientError('owner_unreachable', 'session owner endpoint is unreachable', error);
    }
}

export function createSessionOwnerControlClient(registry: SessionControlRegistry): SessionOwnerControlClient {
    const request = (method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS) =>
        sendRequest(registry, { method, params }, timeoutMs);
    return {
        acquire: async (input) => SessionOwnerControlAcquireResultSchema.parse(await request('session.acquire', input)),
        stop: async (token) => {
            const parsed = SessionOwnerControlTokenSchema.parse(token);
            return SessionStopReceiptSchema.parse(
                await request('session.stop', { token: parsed }, operationRequestTimeout(parsed.timeoutMs)),
            );
        },
        release: async (token) => {
            const parsed = SessionOwnerControlTokenSchema.parse(token);
            return SessionOwnerControlReleaseResultSchema.parse(
                await request('session.release', { token: parsed }, operationRequestTimeout(parsed.timeoutMs)),
            );
        },
    };
}

export async function stopExactSessionOverOwnerControl(
    client: SessionOwnerControlClient,
    input: Parameters<SessionOwnerControlClient['acquire']>[0],
): Promise<SessionStopReceiptContract> {
    const acquired = await client.acquire(input);
    try {
        return await client.stop(acquired.token);
    } finally {
        await client.release(acquired.token);
    }
}

async function sendRequest(
    registry: SessionControlRegistry,
    input: { readonly method: string; readonly params: unknown },
    timeoutMs: number,
): Promise<unknown> {
    const id = randomUUID();
    const socket = await authenticateSessionOwnerControlRegistry(registry);
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (result: { readonly value: unknown } | { readonly error: unknown }): void => {
            if (settled) return;
            settled = true;
            socket.destroy();
            if ('error' in result) reject(result.error);
            else resolve(result.value);
        };
        socket.setTimeout(timeoutMs, () =>
            finish({ error: new SessionOwnerControlClientError('owner_unreachable', 'owner request timed out') }),
        );
        socket.once('error', (error) =>
            finish({
                error: new SessionOwnerControlClientError('owner_unreachable', 'owner connection failed', error),
            }),
        );
        attachSessionOwnerControlFrameReader({
            socket,
            onFrame: (value) => {
                const response = parseSessionOwnerControlFrame(SessionOwnerControlResponseSchema, value);
                if (response.id !== id) {
                    finish({
                        error: new SessionOwnerControlClientError('owner_unreachable', 'owner response id mismatch'),
                    });
                } else if (!response.ok) {
                    finish({ error: new SessionOwnerControlClientError(response.error.code, response.error.message) });
                } else {
                    finish({ value: response.result });
                }
            },
            onError: (error) =>
                finish({ error: new SessionOwnerControlClientError('owner_unreachable', error.message) }),
        });
        socket.write(
            encodeSessionOwnerControlFrame({
                version: SESSION_OWNER_CONTROL_PROTOCOL_VERSION,
                id,
                method: input.method,
                params: input.params,
            }),
        );
    });
}

export function operationRequestTimeout(timeoutMs: number): number {
    return Math.max(REQUEST_TIMEOUT_MS, timeoutMs + REQUEST_TIMEOUT_MS);
}

export function authenticateSessionOwnerControlRegistry(registry: SessionControlRegistry): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(registry.endpoint);
        let buffered = Buffer.alloc(0);
        let settled = false;
        const fail = (code: 'authentication_failed' | 'owner_unreachable', message: string, cause?: unknown): void => {
            if (settled) return;
            settled = true;
            socket.destroy();
            reject(new SessionOwnerControlClientError(code, message, cause));
        };
        socket.setTimeout(REQUEST_TIMEOUT_MS, () => fail('owner_unreachable', 'owner authentication timed out'));
        socket.once('error', (error) => fail('owner_unreachable', 'owner connection failed', error));
        socket.once('connect', () => {
            socket.write(
                encodeSessionOwnerControlFrame({
                    nonce: registry.nonce,
                    owner_id: registry.owner_id,
                    epoch: registry.epoch,
                }),
            );
        });
        socket.on('data', function onData(chunk: Buffer) {
            buffered = Buffer.concat([buffered, chunk]);
            const newline = buffered.indexOf(0x0a);
            if (newline < 0) return;
            socket.removeListener('data', onData);
            if (buffered.subarray(0, newline).toString('utf8') !== '{"ok":true}') {
                fail('authentication_failed', 'owner authentication failed');
                return;
            }
            settled = true;
            socket.setTimeout(0);
            resolve(socket);
        });
    });
}
