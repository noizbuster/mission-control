import { InProcessLspClient, TEAM_TOOL_NAMES, WorkflowRegistry } from '@mission-control/core';
import type { MissionControlConfig } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    gateEnabledConfig,
    goalRuntime,
    prepareGateMatrixWorkspace,
    runtimeServices,
} from './default-tool-gate-matrix-test-support';
import { createInteractiveToolRegistry } from './interactive-coding-tools';
import {
    allowAllPermission,
    fakeBroker,
    noLspServers,
    throwingResolver,
    toolOptions,
    trustedProjectTrustStore,
} from './interactive-coding-tools-test-support';
import { createNonInteractiveToolRegistry } from './noninteractive-tool-registry';
import { closeProductionToolRegistry, type ProductionToolRegistry } from './production-tool-registry';
import { createBufferedChatOutput } from './run-agent-chat-test-support';
import { rm } from 'node:fs/promises';

type HostNames = { readonly interactive: readonly string[]; readonly noninteractive: readonly string[] };
type GateMatrixRow = {
    readonly family: string;
    readonly gate: string;
    readonly candidates: readonly string[];
    readonly defaultNames: HostNames;
    readonly enabledNames: HostNames;
};

const MEMORY_NAMES = ['retain', 'recall', 'reflect', 'memory_edit', 'learn', 'manage_skill'] as const;
const MONITOR_NAMES = ['monitor_start', 'monitor_stop', 'monitor_list', 'monitor_output'] as const;
const GATE_MATRIX = [
    gateRow(['web search', 'provider credential'], ['web_search'], [[], ['web_search']]),
    gateRow(['local memory', 'memory.backend=local'], MEMORY_NAMES, [[], MEMORY_NAMES]),
    gateRow(['team', 'team_mode.enabled'], [...TEAM_TOOL_NAMES, 'irc'], [[], TEAM_TOOL_NAMES]),
    gateRow(['task', 'model resolver and selection'], ['task'], [[], ['task']]),
    gateRow(['job', 'session runtime services'], ['job'], [[], ['job']]),
    {
        family: 'ask user',
        gate: 'interactive callback or noninteractive host',
        candidates: ['ask_user'],
        defaultNames: { interactive: [], noninteractive: ['ask_user'] },
        enabledNames: { interactive: ['ask_user'], noninteractive: ['ask_user'] },
    },
    gateRow(['workflow', 'workflow registry'], ['workflow'], [[], ['workflow']]),
    gateRow(
        ['trusted shell', 'trust plus tmux'],
        ['bash.run', 'interactive_bash', 'shell.session', 'eval'],
        [[], ['bash.run', 'interactive_bash', 'eval']],
    ),
    gateRow(['GitHub', 'trusted workspace plus gh'], ['github'], [[], ['github']]),
    gateRow(['generated media', 'environment credentials'], ['generate_image', 'tts'], [[], ['generate_image', 'tts']]),
    gateRow(
        ['vision', 'execute-time credentials'],
        ['look_at', 'inspect_image'],
        [
            ['look_at', 'inspect_image'],
            ['look_at', 'inspect_image'],
        ],
    ),
    gateRow(['SSH', 'configured host plus missing transport'], ['ssh'], [[], []]),
    gateRow(['LSP', 'client or server transport'], ['lsp', 'lsp_rename'], [[], ['lsp', 'lsp_rename']]),
    gateRow(['MCP', 'configured server'], ['mcp__gate_matrix__echo'], [[], ['mcp__gate_matrix__echo']]),
    gateRow(['browser', 'configured endpoint'], ['browser'], [[], ['browser']]),
    gateRow(['monitor', 'monitor.enabled'], MONITOR_NAMES, [[], MONITOR_NAMES]),
    gateRow(
        ['optional orchestration', 'host callback or debug config'],
        ['report_tool_issue', 'plan_exit', 'goal', 'debug', 'report_finding'],
        [
            [],
            ['report_tool_issue', 'goal', 'debug', 'report_finding'],
            ['report_tool_issue', 'plan_exit', 'goal', 'debug', 'report_finding'],
        ],
    ),
] satisfies readonly GateMatrixRow[];

describe('production tool gate matrix', () => {
    const tempRoots: string[] = [];
    const registries: ProductionToolRegistry[] = [];

    afterEach(async () => {
        await Promise.all(registries.map((registry) => closeProductionToolRegistry(registry)));
        registries.length = 0;
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it.each(GATE_MATRIX)('$family follows the $gate gate in both real hosts', async (row) => {
        // Given
        const defaultWorkspace = await prepareGateMatrixWorkspace(tempRoots, {});
        const defaults = await createDefaultPair(defaultWorkspace);
        registries.push(...defaults);
        const enabledConfig = gateEnabledConfig();
        const enabledWorkspace = await prepareGateMatrixWorkspace(tempRoots, enabledConfig);
        vi.stubEnv('EXA_API_KEY', 'task-13-exa');
        vi.stubEnv('XAI_API_KEY', 'task-13-xai');

        // When
        const enabled = await createEnabledPair(enabledWorkspace, enabledConfig);
        registries.push(...enabled);

        // Then
        expect(selectedNames(defaults[0], row.candidates)).toEqual(row.defaultNames.interactive);
        expect(selectedNames(defaults[1], row.candidates)).toEqual(row.defaultNames.noninteractive);
        expect(selectedNames(enabled[0], row.candidates)).toEqual(row.enabledNames.interactive);
        expect(selectedNames(enabled[1], row.candidates)).toEqual(row.enabledNames.noninteractive);
    }, 20_000);

    it('keeps tmux and transport tools absent when trusted bash has no tmux transport', async () => {
        // Given
        const workspaceRoot = await prepareGateMatrixWorkspace(tempRoots, {
            ssh: { hosts: [{ name: 'prod', host: 'prod.test' }] },
        });

        // When
        const pair = await createTrustedNoTransportPair(workspaceRoot);
        registries.push(...pair);

        // Then
        for (const registry of pair) {
            expect(selectedNames(registry, ['bash.run', 'interactive_bash', 'shell.session', 'eval', 'ssh'])).toEqual([
                'bash.run',
                'eval',
            ]);
        }
    });
});

function gateRow(
    [family, gate]: readonly [family: string, gate: string],
    candidates: readonly string[],
    [defaultNames, enabledNames, enabledInteractiveNames = enabledNames]: readonly [
        defaultNames: readonly string[],
        enabledNames: readonly string[],
        enabledInteractiveNames?: readonly string[],
    ],
): GateMatrixRow {
    return {
        family,
        gate,
        candidates,
        defaultNames: { interactive: defaultNames, noninteractive: defaultNames },
        enabledNames: { interactive: enabledInteractiveNames, noninteractive: enabledNames },
    };
}

async function createDefaultPair(
    workspaceRoot: string,
): Promise<readonly [ProductionToolRegistry, ProductionToolRegistry]> {
    const interactive = await createInteractiveToolRegistry(
        {
            ...toolOptions(createBufferedChatOutput().output, workspaceRoot),
            tmuxAvailable: false,
            ghAvailable: () => false,
        },
        fakeBroker(),
    );
    const noninteractive = await createNonInteractiveToolRegistry({
        workspaceRoot,
        requestPermission: allowAllPermission,
        tmuxAvailable: false,
        ghAvailable: () => false,
        projectTrustStore: trustedProjectTrustStore,
        lspServerManagerDeps: noLspServers,
    });
    return [interactive, noninteractive];
}

async function createEnabledPair(
    workspaceRoot: string,
    config: MissionControlConfig,
): Promise<readonly [ProductionToolRegistry, ProductionToolRegistry]> {
    const services = runtimeServices();
    const lspClient = new InProcessLspClient({});
    const shared = {
        config,
        enableTrustedBash: true,
        tmuxAvailable: true,
        ghAvailable: () => true,
        resolveSdkModel: throwingResolver,
        lspClient,
        workflowRegistry: new WorkflowRegistry(),
        services,
        goalRuntime,
        reportToolIssueSink: () => undefined,
        reportFinding: { onFinding: () => undefined },
    } as const;
    const interactive = await createInteractiveToolRegistry(
        {
            ...toolOptions(createBufferedChatOutput().output, workspaceRoot),
            ...shared,
            requestUserQuestion: () => Promise.resolve('answer'),
            planExit: { onSwitch: () => ({ approved: false }) },
        },
        fakeBroker(),
    );
    const noninteractive = await createNonInteractiveToolRegistry({
        workspaceRoot,
        requestPermission: allowAllPermission,
        modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
        projectTrustStore: trustedProjectTrustStore,
        ...shared,
    });
    return [interactive, noninteractive];
}

async function createTrustedNoTransportPair(
    workspaceRoot: string,
): Promise<readonly [ProductionToolRegistry, ProductionToolRegistry]> {
    const interactive = await createInteractiveToolRegistry(
        {
            ...toolOptions(createBufferedChatOutput().output, workspaceRoot),
            enableTrustedBash: true,
            tmuxAvailable: false,
            ghAvailable: () => false,
        },
        fakeBroker(),
    );
    const noninteractive = await createNonInteractiveToolRegistry({
        workspaceRoot,
        requestPermission: allowAllPermission,
        enableTrustedBash: true,
        tmuxAvailable: false,
        ghAvailable: () => false,
        projectTrustStore: trustedProjectTrustStore,
        lspServerManagerDeps: noLspServers,
    });
    return [interactive, noninteractive];
}

function selectedNames(registry: ProductionToolRegistry, candidates: readonly string[]): readonly string[] {
    return registry.registry
        .advertise()
        .map((tool) => tool.name)
        .filter((name) => candidates.includes(name));
}
