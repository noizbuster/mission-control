import { describe, expect, it, vi } from 'vitest';
import {
    createWindowsSessionControlProxyTransport,
    launchWindowsSessionControlProxy,
} from './session-control-proxy-windows.js';
import { authenticateIncomingSessionControlConnection } from './session-control-registry-auth.js';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

describe('Windows session-control proxy transport', () => {
    it('accepts sequential virtual clients while keeping one native proxy alive', async () => {
        // Given
        const proxyEvents = new PassThrough();
        const proxyCommands = new PassThrough();
        const transport = createWindowsSessionControlProxyTransport(proxyEvents, proxyCommands);
        const connections: import('node:stream').Duplex[] = [];
        transport.onConnection((connection) => connections.push(connection));

        // When
        proxyEvents.write('{"type":"client_connected"}\n');
        await nextTurn();
        const firstData = once(connections[0]!, 'data');
        proxyEvents.write('{"type":"client_data","data":"6669727374"}\n');
        expect((await firstData)[0].toString()).toBe('first');
        const moreData = once(connections[0]!, 'data');
        proxyEvents.write('{"type":"client_data","data":"2d6d6f7265"}\n');
        expect((await moreData)[0].toString()).toBe('-more');
        let firstClosed = false;
        connections[0]?.once('close', () => {
            firstClosed = true;
        });
        proxyEvents.write('{"type":"client_closed"}\n');
        await nextTurn();
        expect(firstClosed).toBe(true);

        proxyEvents.write('{"type":"client_connected"}\n');
        await nextTurn();
        connections[1]?.write('reply');
        const command = await once(proxyCommands, 'data');

        // Then
        expect(connections).toHaveLength(2);
        expect(command[0].toString()).toBe('{"type":"host_data","data":"7265706c79"}\n');
        expect(transport.activeConnections()).toEqual([connections[1]]);
        const closeCommand = once(proxyCommands, 'data');
        connections[1]?.end();
        expect((await closeCommand)[0].toString()).toBe('{"type":"host_close"}\n');
    });

    it.runIf(process.platform !== 'win32')('exercises the real proxy process ready and close lifecycle', async () => {
        // Given
        const directory = await mkdtemp(join(tmpdir(), 'mctrl-proxy-test-'));
        const command = join(directory, 'fake-proxy');
        await writeFile(
            command,
            '#!/usr/bin/env node\nprocess.stdin.once("data",()=>process.stdout.write("{\\"type\\":\\"ready\\"}\\n{\\"type\\":\\"client_connected\\"}\\n"));process.stdin.on("end",()=>process.exit(0));\n',
        );
        await chmod(command, 0o700);

        try {
            // When
            const proxy = await launchWindowsSessionControlProxy({
                command,
                bootstrap: proxyBootstrap(directory),
            });
            const connected = new Promise<void>((resolve) => proxy.onConnection(() => resolve()));

            // Then
            await connected;
            await expect(proxy.close()).resolves.toBeUndefined();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it.runIf(process.platform !== 'win32')('rejects promptly when the proxy exits before ready', async () => {
        // Given
        const directory = await mkdtemp(join(tmpdir(), 'mctrl-proxy-exit-test-'));
        const command = join(directory, 'fake-proxy');
        await writeFile(command, '#!/usr/bin/env node\nprocess.exit(0);\n');
        await chmod(command, 0o700);

        try {
            // When
            const started = Date.now();
            const result = launchWindowsSessionControlProxy({ command, bootstrap: proxyBootstrap(directory) });

            // Then
            await expect(result).rejects.toMatchObject({ code: 'owner_unreachable' });
            expect(Date.now() - started).toBeLessThan(1_000);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('closes the native client when virtual connection authentication times out', async () => {
        // Given
        vi.useFakeTimers();
        const proxyEvents = new PassThrough();
        const proxyCommands = new PassThrough();
        const commands: string[] = [];
        proxyCommands.on('data', (chunk: Buffer) => commands.push(chunk.toString()));
        const transport = createWindowsSessionControlProxyTransport(proxyEvents, proxyCommands);
        transport.onConnection((connection) => {
            authenticateIncomingSessionControlConnection(connection, {
                nonce: 'n'.repeat(43),
                ownerId: 'owner',
                epoch: 1,
            });
        });

        try {
            // When
            proxyEvents.write('{"type":"client_connected"}\n');
            await vi.advanceTimersByTimeAsync(1_000);

            // Then
            expect(commands.join('')).toBe(
                '{"type":"host_data","data":"7b226f6b223a66616c73657d0a"}\n{"type":"host_close"}\n',
            );
        } finally {
            vi.useRealTimers();
        }
    });
});

function nextTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

function proxyBootstrap(directory: string) {
    return {
        registry_dir: directory,
        registry_path: join(directory, 'registry.json'),
        nonce: 'n'.repeat(43),
        pipe_random: 'p'.repeat(22),
        owner_id: 'owner',
        epoch: 1,
        pid: process.pid,
        process_start_id: 'start',
        heartbeat_wall_ms: 1,
        expires_wall_ms: 2,
    };
}
