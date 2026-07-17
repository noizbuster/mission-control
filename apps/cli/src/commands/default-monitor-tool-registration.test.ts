import {
    monitorListOutputSchema,
    monitorOutputOutputSchema,
    monitorStartOutputSchema,
    monitorStopOutputSchema,
} from '@mission-control/core';
import type { MissionControlConfig } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInteractiveToolRegistry } from './interactive-coding-tools';
import {
    allowAllPermission,
    fakeBroker,
    noLspServers,
    toolOptions,
    trustedProjectTrustStore,
} from './interactive-coding-tools-test-support';
import { createNonInteractiveToolRegistry } from './noninteractive-tool-registry';
import { closeProductionToolRegistry, type ProductionToolRegistry } from './production-tool-registry';
import { createBufferedChatOutput } from './run-agent-chat-test-support';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MONITOR_TOOL_NAMES = ['monitor_start', 'monitor_stop', 'monitor_list', 'monitor_output'] as const;

const DISABLED_MONITOR_CONFIG: MissionControlConfig = {
    monitor: {
        enabled: false,
        liveModeEnabled: false,
        maxMonitorsPerSession: 3,
        maxRuntimeMs: 30_000,
    },
};

const ENABLED_MONITOR_CONFIG: MissionControlConfig = {
    monitor: {
        enabled: true,
        liveModeEnabled: false,
        maxMonitorsPerSession: 3,
        maxRuntimeMs: 30_000,
    },
};

type MonitorGateCase = {
    readonly label: string;
    readonly config: MissionControlConfig | undefined;
    readonly expectedNames: readonly string[];
};

const MONITOR_GATE_CASES = [
    { label: 'absent', config: undefined, expectedNames: [] },
    { label: 'disabled', config: DISABLED_MONITOR_CONFIG, expectedNames: [] },
    { label: 'enabled', config: ENABLED_MONITOR_CONFIG, expectedNames: MONITOR_TOOL_NAMES },
] satisfies readonly MonitorGateCase[];

describe('default monitor tool registration', () => {
    const tempRoots: string[] = [];
    const registries: ProductionToolRegistry[] = [];

    afterEach(async () => {
        await Promise.all(registries.map((registry) => closeProductionToolRegistry(registry)));
        registries.length = 0;
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it.each(MONITOR_GATE_CASES)('advertises the exact monitor suite for $label config', async ({
        config,
        expectedNames,
    }) => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);

        // When
        const pair = await createProductionRegistries(workspaceRoot, config);
        registries.push(...pair);

        // Then
        for (const production of pair) {
            expect(monitorToolNames(production)).toEqual(expectedNames);
        }
    });

    it('shares one production manager across start, list, output, and stop', async () => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);
        const production = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowAllPermission,
            enableTrustedBash: true,
            projectTrustStore: trustedProjectTrustStore,
            lspServerManagerDeps: noLspServers,
            sessionId: 'session_monitor_lifecycle',
            config: ENABLED_MONITOR_CONFIG,
        });
        registries.push(production);
        const script = "process.stdout.write('monitor-ready\\n'); setInterval(() => {}, 1000)";

        // When
        const started = monitorStartOutputSchema.parse(
            (
                await invokeMonitorTool(production, 'monitor_start', {
                    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
                    label: 'registry-lifecycle',
                    match_pattern: 'monitor-ready',
                })
            ).structuredOutput,
        );
        const listed = monitorListOutputSchema.parse(
            (await invokeMonitorTool(production, 'monitor_list', {})).structuredOutput,
        );
        const output = await waitForMonitorOutput(production, started.monitorId);
        const stopped = monitorStopOutputSchema.parse(
            (
                await invokeMonitorTool(production, 'monitor_stop', {
                    monitor_id: started.monitorId,
                })
            ).structuredOutput,
        );

        // Then
        expect(started).toMatchObject({ label: 'registry-lifecycle', mode: 'idle', denied: false });
        expect(listed.monitors).toEqual([
            expect.objectContaining({ id: started.monitorId, label: 'registry-lifecycle', status: 'running' }),
        ]);
        expect(output.lines.map((line) => line.text)).toEqual(['monitor-ready']);
        expect(stopped.status).toBe('stopped');
    });

    it('fails closed when stopping an unknown monitor id', async () => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);
        const production = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowAllPermission,
            projectTrustStore: trustedProjectTrustStore,
            lspServerManagerDeps: noLspServers,
            sessionId: 'session_monitor_unknown_stop',
            config: ENABLED_MONITOR_CONFIG,
        });
        registries.push(production);

        // When
        const stopped = monitorStopOutputSchema.parse(
            (
                await invokeMonitorTool(production, 'monitor_stop', {
                    monitor_id: 'monitor_unknown',
                })
            ).structuredOutput,
        );

        // Then
        expect(stopped).toEqual({
            kind: 'monitor_stop',
            monitorId: 'monitor_unknown',
            status: 'already-stopped',
        });
    });
});

async function createProductionRegistries(
    workspaceRoot: string,
    config: MissionControlConfig | undefined,
): Promise<readonly [ProductionToolRegistry, ProductionToolRegistry]> {
    const output = createBufferedChatOutput();
    const configOption = config === undefined ? {} : { config };
    const interactive = await createInteractiveToolRegistry(
        {
            ...toolOptions(output.output, workspaceRoot),
            enableTrustedBash: true,
            ...configOption,
        },
        fakeBroker(),
    );
    const noninteractive = await createNonInteractiveToolRegistry({
        workspaceRoot,
        requestPermission: allowAllPermission,
        enableTrustedBash: true,
        projectTrustStore: trustedProjectTrustStore,
        lspServerManagerDeps: noLspServers,
        ...configOption,
    });
    return [interactive, noninteractive];
}

async function waitForMonitorOutput(
    production: ProductionToolRegistry,
    monitorId: string,
): Promise<ReturnType<typeof monitorOutputOutputSchema.parse>> {
    let output = monitorOutputOutputSchema.parse(
        (await invokeMonitorTool(production, 'monitor_output', { monitor_id: monitorId })).structuredOutput,
    );
    await vi.waitFor(
        async () => {
            output = monitorOutputOutputSchema.parse(
                (await invokeMonitorTool(production, 'monitor_output', { monitor_id: monitorId })).structuredOutput,
            );
            expect(output.lines).toHaveLength(1);
        },
        { timeout: 5_000 },
    );
    return output;
}

function monitorToolNames(production: ProductionToolRegistry): readonly string[] {
    return production.registry
        .advertise()
        .map((advertisement) => advertisement.name)
        .filter(isMonitorToolName);
}

function isMonitorToolName(name: string): boolean {
    return MONITOR_TOOL_NAMES.some((monitorName) => monitorName === name);
}

async function invokeMonitorTool(
    production: ProductionToolRegistry,
    toolName: (typeof MONITOR_TOOL_NAMES)[number],
    input: Readonly<Record<string, unknown>>,
) {
    const advertisement = production.registry.advertise().find((candidate) => candidate.name === toolName);
    if (advertisement === undefined) throw new TypeError(`${toolName} was not advertised`);
    return production.registry.invoke({
        toolCallId: `${toolName}_task_9`,
        toolName,
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify(input),
    });
}

async function prepareWorkspace(tempRoots: string[]): Promise<string> {
    const configRoot = await mkdtemp(join(tmpdir(), 'mctrl-monitor-tools-config-'));
    const dataRoot = await mkdtemp(join(tmpdir(), 'mctrl-monitor-tools-data-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-monitor-tools-workspace-'));
    tempRoots.push(configRoot, dataRoot, workspaceRoot);
    vi.stubEnv('MCTRL_CONFIG_DIR', configRoot);
    vi.stubEnv('MCTRL_DATA_DIR', dataRoot);
    vi.stubEnv('EXA_API_KEY', '');
    vi.stubEnv('PARALLEL_API_KEY', '');
    return workspaceRoot;
}
