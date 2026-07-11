import { afterEach, describe, expect, it } from 'vitest';
import { readSessionControlLease } from './session-control-lease.js';
import { cleanupOperationTestRuntimes, createOperationTestRuntime } from './session-control-operation-test-support.js';
import { publishWindowsSessionControlOwner } from './session-control-owner-windows.js';
import { type WindowsSessionControlProxyLaunchInput, windowsPipeName } from './session-control-proxy-windows.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directories: string[] = [];

afterEach(async () => {
    await cleanupOperationTestRuntimes();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Windows session control owner proxy', () => {
    it('launches the native proxy, publishes its exact registry, renews, and closes without signaling', async () => {
        // Given
        const runtime = await createOperationTestRuntime();
        const registryRoot = await mkdtemp(join(tmpdir(), 'mctrl-windows-owner-'));
        directories.push(registryRoot);
        const launches: WindowsSessionControlProxyLaunchInput[] = [];
        let proxyClosed = false;
        const launchProxy = async (input: WindowsSessionControlProxyLaunchInput) => {
            launches.push(input);
            await mkdir(input.bootstrap.registry_dir, { recursive: true });
            const endpoint = windowsPipeName(input.bootstrap);
            await writeFile(
                input.bootstrap.registry_path,
                JSON.stringify({
                    endpoint,
                    nonce: input.bootstrap.nonce,
                    owner_id: input.bootstrap.owner_id,
                    epoch: input.bootstrap.epoch,
                    pid: input.bootstrap.pid,
                    process_start_id: input.bootstrap.process_start_id,
                    heartbeat_wall_ms: input.bootstrap.heartbeat_wall_ms,
                    expires_wall_ms: input.bootstrap.expires_wall_ms,
                }),
            );
            return {
                endpoint,
                onConnection: () => undefined,
                activeConnections: () => [],
                close: async () => {
                    proxyClosed = true;
                },
            };
        };

        // When
        const owner = await publishWindowsSessionControlOwner({
            runtime,
            dbIdentity: 'd'.repeat(64),
            sessionId: 'session-windows-owner',
            ownerId: 'owner-windows',
            nowWallMs: 1_000,
            sidecarCommand: 'mission-control-sidecar.exe',
            registryRoot,
            launchProxy,
        });

        // Then
        expect(launches).toHaveLength(1);
        expect(launches[0]?.command).toBe('mission-control-sidecar.exe');
        expect(launches[0]?.bootstrap).toMatchObject({ owner_id: 'owner-windows', epoch: 1 });
        await expect(owner.renew(2_000)).resolves.toBe(true);
        await owner.close(2_001);
        expect(proxyClosed).toBe(true);
        expect(await readSessionControlLease(runtime, 'd'.repeat(64), 'session-windows-owner')).toMatchObject({
            expiresWallMs: 2_001,
        });
        runtime.close();
    });
});
