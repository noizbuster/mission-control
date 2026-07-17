import {
    McpConnectionManager,
    MonitorManagerClass,
    type MonitorProcessSpawner,
    ToolRegistry,
} from '@mission-control/core';
import type { MissionControlConfig } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowAllPermission, noLspServers, trustedProjectTrustStore } from './interactive-coding-tools-test-support';
import { createNonInteractiveToolRegistry } from './noninteractive-tool-registry';
import {
    closeProductionToolRegistry,
    createProductionToolRegistry,
    type ProductionToolRegistry,
} from './production-tool-registry';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENABLED_MONITOR_CONFIG: MissionControlConfig = {
    monitor: {
        enabled: true,
        liveModeEnabled: false,
        maxMonitorsPerSession: 3,
        maxRuntimeMs: 30_000,
    },
};

const DISABLED_MONITOR_CONFIG: MissionControlConfig = {
    monitor: {
        enabled: false,
        liveModeEnabled: false,
        maxMonitorsPerSession: 3,
        maxRuntimeMs: 30_000,
    },
};

describe('default monitor production cleanup', () => {
    const tempRoots: string[] = [];
    const registries: ProductionToolRegistry[] = [];

    afterEach(async () => {
        await Promise.all(registries.map((registry) => closeProductionToolRegistry(registry)));
        registries.length = 0;
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('kills an active deterministic monitor exactly once when its production registry closes', async () => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);
        let killCalls = 0;
        const spawner: MonitorProcessSpawner = {
            async spawn() {
                return {
                    kill() {
                        killCalls += 1;
                    },
                    exited: new Promise(() => undefined),
                };
            },
        };
        const manager = new MonitorManagerClass({ spawner });
        await manager.start({
            command: 'deterministic-monitor',
            cwd: workspaceRoot,
            env: {},
            mode: 'idle',
            parentSessionId: 'session_monitor_cleanup',
            redactionSecrets: [],
            maxRuntimeMs: 30_000,
        });
        const production = createProductionToolRegistry(
            {
                registry: new ToolRegistry(),
                mcpConnectionManager: new McpConnectionManager(),
                monitorCleanup: () => manager.shutdown(),
            },
            null,
            false,
        );

        // When
        await closeProductionToolRegistry(production);
        await closeProductionToolRegistry(production);

        // Then
        expect(killCalls).toBe(1);
    });

    it('shuts down the enabled monitor manager when later production setup fails', async () => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);
        const shutdown = vi.spyOn(MonitorManagerClass.prototype, 'shutdown');

        // When
        const setup = createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowAllPermission,
            projectTrustStore: trustedProjectTrustStore,
            config: ENABLED_MONITOR_CONFIG,
            lspServerManagerDeps: {
                commandExists: async () => {
                    throw new Error('monitor cleanup setup failure');
                },
            },
        });

        // Then
        await expect(setup).rejects.toThrow('monitor cleanup setup failure');
        expect(shutdown).toHaveBeenCalledOnce();
    });

    it.each([
        { label: 'absent', config: undefined },
        { label: 'disabled', config: DISABLED_MONITOR_CONFIG },
    ])('creates no monitor cleanup resource for $label config', async ({ config }) => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);
        const shutdown = vi.spyOn(MonitorManagerClass.prototype, 'shutdown');
        const configOption = config === undefined ? {} : { config };

        // When
        const production = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowAllPermission,
            projectTrustStore: trustedProjectTrustStore,
            lspServerManagerDeps: noLspServers,
            ...configOption,
        });
        registries.push(production);
        await closeProductionToolRegistry(production);

        // Then
        expect(production.monitorCleanup).toBeNull();
        expect(shutdown).not.toHaveBeenCalled();
    });
});

async function prepareWorkspace(tempRoots: string[]): Promise<string> {
    const configRoot = await mkdtemp(join(tmpdir(), 'mctrl-monitor-cleanup-config-'));
    const dataRoot = await mkdtemp(join(tmpdir(), 'mctrl-monitor-cleanup-data-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-monitor-cleanup-workspace-'));
    tempRoots.push(configRoot, dataRoot, workspaceRoot);
    vi.stubEnv('MCTRL_CONFIG_DIR', configRoot);
    vi.stubEnv('MCTRL_DATA_DIR', dataRoot);
    vi.stubEnv('EXA_API_KEY', '');
    vi.stubEnv('PARALLEL_API_KEY', '');
    return workspaceRoot;
}
