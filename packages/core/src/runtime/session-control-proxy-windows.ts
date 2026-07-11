import { SessionControlOwnerError } from './session-control-owner-error.js';
import { windowsSessionControlProxyInvocation } from './session-control-platform.js';
import { readWindowsProxyReady, waitForWindowsProxyExit } from './session-control-proxy-windows-lifecycle.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, type Readable, type Writable } from 'node:stream';

const MAX_PROXY_FRAME_BYTES = 262_144;

export type WindowsSessionControlProxyBootstrap = {
    readonly registry_dir: string;
    readonly registry_path: string;
    readonly nonce: string;
    readonly pipe_random: string;
    readonly owner_id: string;
    readonly epoch: number;
    readonly pid: number;
    readonly process_start_id: string;
    readonly heartbeat_wall_ms: number;
    readonly expires_wall_ms: number;
};

export type WindowsSessionControlProxy = {
    readonly endpoint: string;
    readonly onConnection: (handler: (connection: Duplex) => void) => void;
    readonly activeConnections: () => readonly Duplex[];
    readonly close: () => Promise<void>;
};

export type WindowsSessionControlPaths = {
    readonly registryDir: string;
    readonly registryPath: string;
};

export type WindowsSessionControlProxyLaunchInput = {
    readonly command: string;
    readonly bootstrap: WindowsSessionControlProxyBootstrap;
};

export async function launchWindowsSessionControlProxy(
    input: WindowsSessionControlProxyLaunchInput,
): Promise<WindowsSessionControlProxy> {
    const invocation = windowsSessionControlProxyInvocation(input.command);
    const child = spawn(invocation.command, invocation.args, {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
    });
    const stdin = requirePipe(child.stdin, 'stdin');
    const stdout = requirePipe(child.stdout, 'stdout');
    const ready = readWindowsProxyReady(child, stdout, stdin);
    stdin.write(`${JSON.stringify(input.bootstrap)}\n`);
    let initialBytes: Buffer;
    try {
        initialBytes = await ready;
    } catch (error: unknown) {
        stdin.end();
        await waitForWindowsProxyExit(child).catch(() => undefined);
        throw error;
    }
    const transport = createWindowsSessionControlProxyTransport(stdout, stdin, initialBytes);
    stdout.resume();
    child.once('error', (error) => stdout.destroy(error));
    let closing: Promise<void> | undefined;
    return {
        endpoint: windowsPipeName(input.bootstrap),
        ...transport,
        close: () => {
            if (closing !== undefined) return closing;
            stdin.end();
            closing = waitForWindowsProxyExit(child);
            return closing;
        },
    };
}

export function createWindowsSessionControlProxyTransport(
    events: Readable,
    commands: Writable,
    initialBytes: Uint8Array = Buffer.alloc(0),
): Pick<WindowsSessionControlProxy, 'onConnection' | 'activeConnections'> {
    let buffered = Buffer.from(initialBytes);
    let connection: Duplex | undefined;
    let handler: ((connection: Duplex) => void) | undefined;
    const pendingConnections: Duplex[] = [];
    const fail = (error: Error): void => {
        connection?.destroy(error);
        connection = undefined;
        events.destroy(error);
    };
    const consume = (chunk: Buffer): void => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.byteLength > MAX_PROXY_FRAME_BYTES && buffered.indexOf(0x0a) < 0) {
            fail(new Error('Windows proxy event frame exceeds the byte limit'));
            return;
        }
        let newline = buffered.indexOf(0x0a);
        while (newline >= 0) {
            const frame = buffered.subarray(0, newline);
            buffered = buffered.subarray(newline + 1);
            try {
                if (frame.byteLength > MAX_PROXY_FRAME_BYTES) throw new Error('Windows proxy event frame is too large');
                const event = parseProxyEvent(frame);
                if (event.type === 'client_connected') {
                    if (connection !== undefined) throw new Error('Windows proxy connected clients overlap');
                    connection = createProxyConnection(commands);
                    if (handler === undefined) pendingConnections.push(connection);
                    else handler(connection);
                } else if (event.type === 'client_data') {
                    if (connection === undefined) throw new Error('Windows proxy data has no client');
                    connection.push(Buffer.from(event.data, 'hex'));
                } else {
                    if (connection === undefined) throw new Error('Windows proxy close has no client');
                    const closedConnection = connection;
                    connection = undefined;
                    closedConnection.push(null);
                    closedConnection.destroy();
                }
            } catch (error: unknown) {
                fail(error instanceof Error ? error : new Error('Windows proxy event is invalid'));
                return;
            }
            newline = buffered.indexOf(0x0a);
        }
    };
    events.on('data', consume);
    events.once('end', () => {
        connection?.push(null);
        connection?.destroy();
        connection = undefined;
    });
    events.once('error', (error) => connection?.destroy(error));
    if (buffered.byteLength > 0) consume(Buffer.alloc(0));
    return {
        onConnection: (nextHandler) => {
            handler = nextHandler;
            for (const pending of pendingConnections.splice(0)) nextHandler(pending);
        },
        activeConnections: () => (connection === undefined ? [] : [connection]),
    };
}

export function resolveWindowsSessionControlPaths(
    dbIdentity: string,
    sessionId: string,
    registryRoot = tmpdir(),
): WindowsSessionControlPaths {
    if (!/^[0-9a-f]{64}$/u.test(dbIdentity) || sessionId.length === 0) {
        throw new TypeError('invalid Windows session control identity');
    }
    const registryDir = join(registryRoot, 'mission-control-session-control');
    const registryName = `${createHash('sha256').update(dbIdentity).update('\0').update(sessionId).digest('hex')}.json`;
    return { registryDir, registryPath: join(registryDir, registryName) };
}

export function windowsPipeName(bootstrap: Pick<WindowsSessionControlProxyBootstrap, 'nonce' | 'pipe_random'>): string {
    return `\\\\.\\pipe\\mission-control-${bootstrap.pipe_random}-${bootstrap.nonce}`;
}

function createProxyConnection(commands: Writable): Duplex {
    return new Duplex({
        read: () => undefined,
        write: (chunk, _encoding, callback) => {
            commands.write(proxyCommand('host_data', Buffer.from(chunk).toString('hex')), callback);
        },
        final: (callback) => commands.write(proxyCommand('host_close'), callback),
    });
}

function parseProxyEvent(
    frame: Buffer,
): { readonly type: 'client_connected' | 'client_closed' } | { readonly type: 'client_data'; readonly data: string } {
    const value: unknown = JSON.parse(frame.toString('utf8'));
    if (typeof value !== 'object' || value === null || !('type' in value)) throw new Error('invalid proxy event');
    if (value.type === 'client_connected' || value.type === 'client_closed') return { type: value.type };
    if (
        value.type === 'client_data' &&
        'data' in value &&
        typeof value.data === 'string' &&
        value.data.length % 2 === 0 &&
        /^[0-9a-f]*$/u.test(value.data)
    ) {
        return { type: 'client_data', data: value.data };
    }
    throw new Error('invalid proxy event');
}

function proxyCommand(type: 'host_data' | 'host_close', data?: string): string {
    return `${JSON.stringify({ type, ...(data !== undefined ? { data } : {}) })}\n`;
}

function requirePipe<T>(pipe: T | null, name: string): T {
    if (pipe === null)
        throw new SessionControlOwnerError('owner_unreachable', `Windows owner proxy ${name} is unavailable`);
    return pipe;
}
