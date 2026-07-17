import {
    createDefaultTeamToolRuntime,
    type MemberSpawnRequest,
    TEAM_TOOL_NAMES,
    TeamToolNotImplementedError,
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

type TeamGateCase = {
    readonly label: string;
    readonly config: MissionControlConfig | undefined;
    readonly expectedNames: readonly string[];
};

const TEAM_GATE_CASES = [
    { label: 'absent', config: undefined, expectedNames: [] },
    { label: 'disabled', config: teamConfig(false), expectedNames: [] },
    { label: 'enabled', config: teamConfig(true), expectedNames: TEAM_TOOL_NAMES },
] satisfies readonly TeamGateCase[];

describe('default team and IRC tool registration', () => {
    const tempRoots: string[] = [];
    const registries: ProductionToolRegistry[] = [];

    afterEach(async () => {
        await Promise.all(registries.map((registry) => closeProductionToolRegistry(registry)));
        registries.length = 0;
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it.each(TEAM_GATE_CASES)('advertises the exact team suite for $label config in both hosts', async ({
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
            expect(teamToolNames(production)).toEqual(expectedNames);
        }
    });

    it('keeps IRC unadvertised when the host has no caller identity plus paired live registry and bus', async () => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);

        // When
        const pair = await createProductionRegistries(workspaceRoot, teamConfig(true));
        registries.push(...pair);

        // Then
        for (const production of pair) {
            expect(advertisedNames(production)).not.toContain('irc');
        }
    });

    it('rejects default member spawning with the typed not-implemented error', async () => {
        // Given
        const runtime = createDefaultTeamToolRuntime();
        const request: MemberSpawnRequest = {
            teamRunId: 'team_default_runtime',
            leadSessionId: 'session_lead',
            member: { name: 'worker', kind: 'category', category: 'quick' },
        };

        // When
        const spawn = runtime.spawnMember(request);

        // Then
        await expect(spawn).rejects.toBeInstanceOf(TeamToolNotImplementedError);
    });
});

function teamConfig(enabled: boolean): MissionControlConfig {
    return {
        team_mode: {
            enabled,
            maxParallelMembers: 4,
            maxMembers: 8,
            messagePayloadMaxBytes: 32_768,
            recipientUnreadMaxBytes: 262_144,
        },
    };
}

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

function advertisedNames(production: ProductionToolRegistry): readonly string[] {
    return production.registry.advertise().map((advertisement) => advertisement.name);
}

function teamToolNames(production: ProductionToolRegistry): readonly string[] {
    return advertisedNames(production).filter((name) => name.startsWith('team_'));
}

async function prepareWorkspace(tempRoots: string[]): Promise<string> {
    const configRoot = await mkdtemp(join(tmpdir(), 'mctrl-team-tools-config-'));
    const dataRoot = await mkdtemp(join(tmpdir(), 'mctrl-team-tools-data-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-team-tools-workspace-'));
    tempRoots.push(configRoot, dataRoot, workspaceRoot);
    vi.stubEnv('MCTRL_CONFIG_DIR', configRoot);
    vi.stubEnv('MCTRL_DATA_DIR', dataRoot);
    vi.stubEnv('EXA_API_KEY', '');
    vi.stubEnv('PARALLEL_API_KEY', '');
    return workspaceRoot;
}
