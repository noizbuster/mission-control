import { z } from 'zod';
import type { SessionControlRegistry } from './session-control-registry-file';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

const NONCE_BYTES = 32;
const MAX_AUTH_REQUEST_BYTES = 2_048;
const AUTH_TIMEOUT_MS = 1_000;
const preservedDuringClose = new WeakSet<Duplex>();
const deferredConnectionCloses = new WeakMap<Duplex, Set<() => void>>();

const authRequestSchema = z
    .object({
        nonce: z.string(),
        owner_id: z.string(),
        epoch: z.number().int().positive(),
    })
    .strict();

export type AuthenticatedSessionControlServer = {
    readonly close: () => Promise<void>;
};

export function preserveAuthenticatedSessionControlSocketDuringClose(connection: Duplex): () => void {
    preservedDuringClose.add(connection);
    let restored = false;
    return () => {
        if (restored) return;
        restored = true;
        preservedDuringClose.delete(connection);
        const deferred = deferredConnectionCloses.get(connection);
        deferredConnectionCloses.delete(connection);
        for (const close of deferred ?? []) close();
    };
}

export function deferAuthenticatedSessionControlConnectionClose(connection: Duplex, close: () => void): boolean {
    if (!preservedDuringClose.has(connection)) return false;
    const deferred = deferredConnectionCloses.get(connection) ?? new Set<() => void>();
    deferred.add(close);
    deferredConnectionCloses.set(connection, deferred);
    return true;
}

export function generateSessionControlNonce(): string {
    return randomBytes(NONCE_BYTES).toString('base64url');
}

export function sessionControlNonceHash(nonce: string): string {
    const decoded = decodeNonce(nonce);
    if (decoded === undefined) {
        throw new Error('Invalid session control nonce');
    }
    return createHash('sha256').update(decoded).digest('hex');
}

export function matchesSessionControlNonce(expected: string, presented: string): boolean {
    const decodedExpected = decodeNonce(expected);
    const decodedPresented = decodeNonce(presented);
    const equal = timingSafeEqual(
        decodedExpected ?? Buffer.alloc(NONCE_BYTES),
        decodedPresented ?? Buffer.alloc(NONCE_BYTES),
    );
    return equal && decodedExpected !== undefined && decodedPresented !== undefined;
}

export async function createAuthenticatedSessionControlServer(input: {
    readonly socketPath: string;
    readonly nonce: string;
    readonly ownerId: string;
    readonly epoch: number;
    readonly onAuthenticated?: (connection: Duplex, initialBytes: Buffer) => void;
}): Promise<AuthenticatedSessionControlServer> {
    if (decodeNonce(input.nonce) === undefined) {
        throw new Error('Invalid session control nonce');
    }
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        authenticateIncomingSessionControlConnection(socket, input);
    });
    await listen(server, input.socketPath);
    try {
        await chmod(input.socketPath, 0o600);
        const socketIdentity = await lstat(input.socketPath);
        return {
            close: async () => {
                const preserved = [...sockets].filter((socket) => preservedDuringClose.has(socket));
                for (const socket of sockets) {
                    if (!preservedDuringClose.has(socket)) socket.destroy();
                }
                const closing = closeServer(server);
                if (preserved.length === 0) await closing;
                else void closing.catch(() => undefined);
                await removeMatchingSocket(input.socketPath, socketIdentity.dev, socketIdentity.ino);
            },
        };
    } catch (error: unknown) {
        await closeServer(server);
        throw error;
    }
}

export async function authenticateSessionControlEndpoint(
    registry: SessionControlRegistry,
    timeoutMs = AUTH_TIMEOUT_MS,
): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = createConnection(registry.endpoint);
        let settled = false;
        let buffered = '';
        const finish = (authenticated: boolean): void => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(authenticated);
        };
        socket.setTimeout(timeoutMs, () => finish(false));
        socket.once('error', () => finish(false));
        socket.once('connect', () => {
            socket.write(
                `${JSON.stringify({ nonce: registry.nonce, owner_id: registry.owner_id, epoch: registry.epoch })}\n`,
            );
        });
        socket.on('data', (chunk: Buffer) => {
            buffered += chunk.toString('utf8');
            const newline = buffered.indexOf('\n');
            if (newline >= 0) {
                finish(buffered.slice(0, newline) === '{"ok":true}');
            } else if (Buffer.byteLength(buffered) > MAX_AUTH_REQUEST_BYTES) {
                finish(false);
            }
        });
    });
}

export function authenticateIncomingSessionControlConnection(
    connection: Duplex,
    input: {
        readonly nonce: string;
        readonly ownerId: string;
        readonly epoch: number;
        readonly onAuthenticated?: (connection: Duplex, initialBytes: Buffer) => void;
    },
    initialBytes: Buffer<ArrayBufferLike> = Buffer.alloc(0),
): void {
    let buffered = initialBytes;
    const timeout = setTimeout(() => {
        connection.removeListener('data', onData);
        connection.end('{"ok":false}\n');
    }, AUTH_TIMEOUT_MS);
    timeout.unref();
    const onData = (chunk: Buffer): void => {
        buffered = Buffer.concat([buffered, chunk]);
        const newline = buffered.indexOf(0x0a);
        if (newline < 0 && buffered.byteLength <= MAX_AUTH_REQUEST_BYTES) return;
        clearTimeout(timeout);
        connection.removeListener('data', onData);
        if (newline < 0) {
            connection.end('{"ok":false}\n');
            return;
        }
        const authenticated = parseAuthRequest(buffered.subarray(0, newline), input);
        if (!authenticated) {
            connection.end('{"ok":false}\n');
            return;
        }
        connection.write('{"ok":true}\n');
        input.onAuthenticated?.(connection, buffered.subarray(newline + 1));
        if (input.onAuthenticated === undefined) connection.end();
    };
    connection.on('data', onData);
    if (buffered.byteLength > 0) onData(Buffer.alloc(0));
}

function parseAuthRequest(
    bytes: Buffer,
    expected: { readonly nonce: string; readonly ownerId: string; readonly epoch: number },
): boolean {
    try {
        const parsed = authRequestSchema.parse(JSON.parse(bytes.toString('utf8')));
        return (
            parsed.owner_id === expected.ownerId &&
            parsed.epoch === expected.epoch &&
            matchesSessionControlNonce(expected.nonce, parsed.nonce)
        );
    } catch {
        return false;
    }
}

function decodeNonce(nonce: string): Buffer | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(nonce)) return undefined;
    const decoded = Buffer.from(nonce, 'base64url');
    return decoded.byteLength === NONCE_BYTES && decoded.toString('base64url') === nonce ? decoded : undefined;
}

function listen(server: Server, socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
}

function closeServer(server: Server): Promise<void> {
    if (!server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
}

async function removeMatchingSocket(path: string, device: number, inode: number): Promise<void> {
    try {
        const current = await lstat(path);
        if (current.dev === device && current.ino === inode) await rm(path);
    } catch (error: unknown) {
        if (!isErrorCode(error, 'ENOENT')) throw error;
    }
}

function isErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
