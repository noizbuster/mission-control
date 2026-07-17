import type { CommandExecutionRequest, CommandExecutionResult } from '@mission-control/core';
import type { MissionControlConfig } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInteractiveToolRegistry, type InteractiveToolOptions } from './interactive-coding-tools';
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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXTERNAL_MEDIA_TOOL_NAMES = ['github', 'generate_image', 'tts', 'look_at', 'inspect_image', 'ssh'] as const;
const CREDENTIAL_ENV_KEYS = [
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GOOGLE_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'XAI_API_KEY',
    'ZAI_API_KEY',
    'ZHIPU_API_KEY',
] as const;
const TINY_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

type RegistryGateOptions = {
    readonly config?: MissionControlConfig;
    readonly enableTrustedBash?: boolean;
    readonly ghAvailable?: InteractiveToolOptions['ghAvailable'];
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
};

describe('default external and media tool registration', () => {
    const tempRoots: string[] = [];
    const registries: ProductionToolRegistry[] = [];

    afterEach(async () => {
        await Promise.all(registries.map((registry) => closeProductionToolRegistry(registry)));
        registries.length = 0;
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it.each([
        { label: 'gh is absent', enableTrustedBash: true, ghAvailable: () => false },
        { label: 'workspace trust is absent', enableTrustedBash: false, ghAvailable: () => true },
    ])('omits github when $label in both production hosts', async ({ enableTrustedBash, ghAvailable }) => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);

        // When
        const pair = await createProductionRegistries(workspaceRoot, { enableTrustedBash, ghAvailable });
        registries.push(...pair);

        // Then
        for (const production of pair) expect(advertisedNames(production)).not.toContain('github');
    });

    it('advertises github in both trusted production hosts when the real availability seam passes', async () => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);

        // When
        const pair = await createProductionRegistries(workspaceRoot, {
            enableTrustedBash: true,
            ghAvailable: () => true,
        });
        registries.push(...pair);

        // Then
        for (const production of pair) expect(advertisedNames(production)).toContain('github');
    });

    it('keeps generated media hidden without credentials while vision stays execute-time fail-closed', async () => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);
        const production = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowAllPermission,
            projectTrustStore: trustedProjectTrustStore,
            lspServerManagerDeps: noLspServers,
            ghAvailable: () => false,
        });
        registries.push(production);

        // When
        const visionSettlements = await Promise.all([
            invokeTool(production, 'look_at', { image_data: TINY_PNG_BASE64, goal: 'describe' }),
            invokeTool(production, 'inspect_image', { image_data: TINY_PNG_BASE64, goal: 'describe' }),
        ]);

        // Then
        expect(externalMediaToolNames(production)).toEqual(['look_at', 'inspect_image']);
        for (const settlement of visionSettlements) {
            expect(settlement.result.status).toBe('failed');
            expect(settlement.result.error?.message).toContain('No vision provider credential');
        }
    });

    it('advertises generated image and TTS only when their existing credential gates pass without exposing secrets', async () => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);
        const credential = ['task11', 'media', 'credential'].join('_');
        vi.stubEnv('XAI_API_KEY', credential);

        // When
        const pair = await createProductionRegistries(workspaceRoot, { ghAvailable: () => false });
        registries.push(...pair);

        // Then
        for (const production of pair) {
            expect(externalMediaToolNames(production)).toEqual(['generate_image', 'tts', 'look_at', 'inspect_image']);
            expect(JSON.stringify(production.registry.advertise())).not.toContain(credential);
        }
    });

    it('threads the workspace guard through the normal vision registration before provider I/O', async () => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);
        const outsideRoot = await mkdtemp(join(tmpdir(), 'mctrl-external-tools-outside-'));
        tempRoots.push(outsideRoot);
        const outsideImage = join(outsideRoot, 'outside.png');
        await writeFile(outsideImage, Buffer.from(TINY_PNG_BASE64, 'base64'));
        vi.stubEnv('OPENAI_API_KEY', 'vision-test-key');
        const fetchMock = vi.fn(() =>
            Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'unsafe' } }] }))),
        );
        vi.stubGlobal('fetch', fetchMock);
        const production = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowAllPermission,
            projectTrustStore: trustedProjectTrustStore,
            lspServerManagerDeps: noLspServers,
            ghAvailable: () => false,
        });
        registries.push(production);

        // When
        const settlement = await invokeTool(production, 'look_at', {
            file_path: outsideImage,
            goal: 'describe',
        });

        // Then
        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('workspace_escape');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('threads TTS write permission through the normal registration before provider I/O', async () => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);
        vi.stubEnv('XAI_API_KEY', 'tts-test-key');
        const fetchMock = vi.fn(() => Promise.resolve(new Response(new Uint8Array([1, 2, 3]))));
        vi.stubGlobal('fetch', fetchMock);
        const production = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: async (request) => ({
                requestId: request.id,
                status: 'deny',
                reason: 'test deny',
            }),
            projectTrustStore: trustedProjectTrustStore,
            lspServerManagerDeps: noLspServers,
            ghAvailable: () => false,
        });
        registries.push(production);

        // When
        const settlement = await invokeTool(production, 'tts', {
            text: 'hello',
            voice_id: 'eve',
            language: 'en',
            output_path: 'audio/clip.wav',
        });

        // Then
        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('test deny');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
        { label: 'empty hosts', config: { ssh: { hosts: [] } } },
        {
            label: 'configured hosts without a production transport',
            config: { ssh: { hosts: [{ name: 'prod', host: 'prod.example' }] } },
        },
    ] satisfies readonly {
        readonly label: string;
        readonly config: MissionControlConfig;
    }[])('keeps ssh unadvertised for $label in both production hosts', async ({ config }) => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);

        // When
        const pair = await createProductionRegistries(workspaceRoot, { config, enableTrustedBash: true });
        registries.push(...pair);

        // Then
        for (const production of pair) expect(advertisedNames(production)).not.toContain('ssh');
    });

    it('redacts a forwarded GitHub credential from production tool settlements', async () => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);
        const credential = ['task11', 'github', 'credential'].join('_');
        vi.stubEnv('GH_TOKEN', credential);
        const production = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowAllPermission,
            enableTrustedBash: true,
            ghAvailable: () => true,
            commandExecutor: async () => completedCommand(`credential=${credential}`),
            projectTrustStore: trustedProjectTrustStore,
            lspServerManagerDeps: noLspServers,
        });
        registries.push(production);

        // When
        const settlement = await invokeTool(production, 'github', { op: 'repo_view', repo: 'owner/repo' });

        // Then
        expect(settlement.result.status).toBe('completed');
        expect(JSON.stringify(settlement)).not.toContain(credential);
        expect(JSON.stringify(settlement)).toContain('[REDACTED_CREDENTIAL]');
    });
});

async function createProductionRegistries(
    workspaceRoot: string,
    options: RegistryGateOptions,
): Promise<readonly [ProductionToolRegistry, ProductionToolRegistry]> {
    const output = createBufferedChatOutput();
    const shared = {
        ...(options.config !== undefined ? { config: options.config } : {}),
        ...(options.enableTrustedBash !== undefined ? { enableTrustedBash: options.enableTrustedBash } : {}),
        ...(options.ghAvailable !== undefined ? { ghAvailable: options.ghAvailable } : {}),
        ...(options.commandExecutor !== undefined ? { commandExecutor: options.commandExecutor } : {}),
    };
    const interactive = await createInteractiveToolRegistry(
        { ...toolOptions(output.output, workspaceRoot), ...shared },
        fakeBroker(),
    );
    const noninteractive = await createNonInteractiveToolRegistry({
        workspaceRoot,
        requestPermission: allowAllPermission,
        projectTrustStore: trustedProjectTrustStore,
        lspServerManagerDeps: noLspServers,
        ...shared,
    });
    return [interactive, noninteractive];
}

async function invokeTool(
    production: ProductionToolRegistry,
    toolName: string,
    input: Readonly<Record<string, unknown>>,
) {
    const advertisement = production.registry.advertise().find((candidate) => candidate.name === toolName);
    if (advertisement === undefined) throw new TypeError(`${toolName} was not advertised`);
    return production.registry.invoke({
        toolCallId: `${toolName}_task_11`,
        toolName,
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify(input),
    });
}

function completedCommand(stdout: string): CommandExecutionResult {
    return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: '', durationMs: 1 };
}

function advertisedNames(production: ProductionToolRegistry): readonly string[] {
    return production.registry.advertise().map((advertisement) => advertisement.name);
}

function externalMediaToolNames(production: ProductionToolRegistry): readonly string[] {
    return advertisedNames(production).filter((name) =>
        EXTERNAL_MEDIA_TOOL_NAMES.some((candidate) => candidate === name),
    );
}

async function prepareWorkspace(tempRoots: string[]): Promise<string> {
    const configRoot = await mkdtemp(join(tmpdir(), 'mctrl-external-tools-config-'));
    const dataRoot = await mkdtemp(join(tmpdir(), 'mctrl-external-tools-data-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-external-tools-workspace-'));
    tempRoots.push(configRoot, dataRoot, workspaceRoot);
    vi.stubEnv('MCTRL_CONFIG_DIR', configRoot);
    vi.stubEnv('MCTRL_DATA_DIR', dataRoot);
    vi.stubEnv('EXA_API_KEY', '');
    vi.stubEnv('PARALLEL_API_KEY', '');
    for (const key of CREDENTIAL_ENV_KEYS) vi.stubEnv(key, '');
    return workspaceRoot;
}
