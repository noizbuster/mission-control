import type { ProviderTurnRequest } from '@mission-control/core';
import type { MissionControlConfig } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
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
import { runAgent } from './run-agent';
import { createBufferedChatOutput, createEmptyAuthStore, createScriptedChatInput } from './run-agent-chat-test-support';
import { firstAdvertisedToolNames, providerFromTurns } from './run-agent-tool-registry-test-support';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MEMORY_TOOL_NAMES = ['retain', 'recall', 'reflect', 'memory_edit', 'learn', 'manage_skill'] as const;

type MemoryGateCase = {
    readonly label: string;
    readonly config: MissionControlConfig | undefined;
    readonly expectedNames: readonly string[];
};

const MEMORY_GATE_CASES = [
    { label: 'undefined', config: undefined, expectedNames: [] },
    { label: 'off', config: { memory: { backend: 'off' } }, expectedNames: [] },
    { label: 'local', config: { memory: { backend: 'local' } }, expectedNames: MEMORY_TOOL_NAMES },
    { label: 'mnemopi', config: { memory: { backend: 'mnemopi' } }, expectedNames: [] },
    { label: 'hindsight', config: { memory: { backend: 'hindsight' } }, expectedNames: [] },
] satisfies readonly MemoryGateCase[];

describe('default local memory tool registration', () => {
    const tempRoots: string[] = [];
    const registries: ProductionToolRegistry[] = [];

    afterEach(async () => {
        await Promise.all(registries.map((registry) => closeProductionToolRegistry(registry)));
        registries.length = 0;
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it.each(MEMORY_GATE_CASES)('advertises the exact memory suite for $label config', async ({
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
            expect(memoryToolNames(production)).toEqual(expectedNames);
        }
    });

    it('retains then recalls through one local production registry', async () => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);
        const production = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowAllPermission,
            projectTrustStore: trustedProjectTrustStore,
            lspServerManagerDeps: noLspServers,
            config: { memory: { backend: 'local' } },
        });
        registries.push(production);

        // When
        const retained = await invokeMemoryTool(production, 'retain', {
            items: [{ content: 'Task 8 local registry memory', context: 'focused production test' }],
        });
        const recalled = await invokeMemoryTool(production, 'recall', { query: 'Task 8 local registry' });

        // Then
        expect(retained.result.status).toBe('completed');
        expect(retained.structuredOutput).toMatchObject({ status: 'stored', count: 1, backend: 'local' });
        expect(recalled.result.status).toBe('completed');
        expect(recalled.structuredOutput).toMatchObject({
            status: 'ok',
            count: 1,
            backend: 'local',
            memories: [{ content: 'Task 8 local registry memory', context: 'focused production test' }],
        });
    });

    it('threads the selected local config file into the production registry', async () => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots, { memory: { backend: 'local' } });
        const requests: ProviderTurnRequest[] = [];
        const chatOutput = createBufferedChatOutput();

        // When
        await runAgent(parseArgs(['--session', 'session_task_8_memory_config']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput(
                [{ type: 'line', value: 'inspect local memory tools' }, { type: 'interrupt' }, { type: 'interrupt' }],
                50,
            ),
            chatOutput: chatOutput.output,
            workspaceRoot,
            provider: providerFromTurns(requests, [[{ kind: 'response_completed', content: 'done' }]]),
            plainPromptGraph: 'coding-agent',
        });

        // Then
        expect(firstAdvertisedToolNames(requests).filter(isMemoryToolName)).toEqual(MEMORY_TOOL_NAMES);
    }, 20_000);
});

async function createProductionRegistries(
    workspaceRoot: string,
    config: MissionControlConfig | undefined,
): Promise<readonly [ProductionToolRegistry, ProductionToolRegistry]> {
    const output = createBufferedChatOutput();
    const configOption = config === undefined ? {} : { config };
    const interactive = await createInteractiveToolRegistry(
        { ...toolOptions(output.output, workspaceRoot), ...configOption },
        fakeBroker(),
    );
    const noninteractive = await createNonInteractiveToolRegistry({
        workspaceRoot,
        requestPermission: allowAllPermission,
        projectTrustStore: trustedProjectTrustStore,
        lspServerManagerDeps: noLspServers,
        ...configOption,
    });
    return [interactive, noninteractive];
}

function memoryToolNames(production: ProductionToolRegistry): readonly string[] {
    return production.registry
        .advertise()
        .map((advertisement) => advertisement.name)
        .filter(isMemoryToolName);
}

function isMemoryToolName(name: string): boolean {
    return MEMORY_TOOL_NAMES.some((memoryName) => memoryName === name);
}

async function invokeMemoryTool(
    production: ProductionToolRegistry,
    toolName: (typeof MEMORY_TOOL_NAMES)[number],
    input: Readonly<Record<string, unknown>>,
) {
    const advertisement = production.registry.advertise().find((candidate) => candidate.name === toolName);
    if (advertisement === undefined) throw new TypeError(`${toolName} was not advertised`);
    return production.registry.invoke({
        toolCallId: `${toolName}_task_8`,
        toolName,
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify(input),
    });
}

async function prepareWorkspace(tempRoots: string[], config?: MissionControlConfig): Promise<string> {
    const configRoot = await mkdtemp(join(tmpdir(), 'mctrl-memory-tools-config-'));
    const dataRoot = await mkdtemp(join(tmpdir(), 'mctrl-memory-tools-data-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-memory-tools-workspace-'));
    tempRoots.push(configRoot, dataRoot, workspaceRoot);
    if (config !== undefined) await writeFile(join(configRoot, 'config.json'), JSON.stringify(config), 'utf8');
    vi.stubEnv('MCTRL_CONFIG_DIR', configRoot);
    vi.stubEnv('MCTRL_DATA_DIR', dataRoot);
    vi.stubEnv('EXA_API_KEY', '');
    vi.stubEnv('PARALLEL_API_KEY', '');
    return workspaceRoot;
}
