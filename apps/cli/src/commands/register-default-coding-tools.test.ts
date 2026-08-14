import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { MissingWorkspaceRootError } from './register-default-coding-tools';
import { createBufferedChatOutput } from './run-agent-chat-test-support';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('default coding tool registry characterization', () => {
    const tempRoots: string[] = [];
    const registries: ProductionToolRegistry[] = [];

    afterEach(async () => {
        await Promise.all(registries.map((registry) => closeProductionToolRegistry(registry)));
        registries.length = 0;
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('preserves the current interactive and noninteractive registration order', async () => {
        // Given
        const configRoot = await createTempRoot(tempRoots, 'mctrl-default-tools-config-');
        const dataRoot = await createTempRoot(tempRoots, 'mctrl-default-tools-data-');
        const interactiveWorkspace = await createTempRoot(tempRoots, 'mctrl-default-tools-interactive-');
        const noninteractiveWorkspace = await createTempRoot(tempRoots, 'mctrl-default-tools-noninteractive-');
        vi.stubEnv('MCTRL_CONFIG_DIR', configRoot);
        vi.stubEnv('MCTRL_DATA_DIR', dataRoot);
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('PARALLEL_API_KEY', '');
        vi.stubEnv('GEMINI_API_KEY', '');
        vi.stubEnv('GOOGLE_API_KEY', '');
        vi.stubEnv('OPENAI_API_KEY', '');
        vi.stubEnv('XAI_API_KEY', '');
        const output = createBufferedChatOutput();

        // When
        const interactive = await createInteractiveToolRegistry(
            toolOptions(output.output, interactiveWorkspace, throwingResolver),
            fakeBroker(),
        );
        registries.push(interactive);
        const noninteractive = await createNonInteractiveToolRegistry({
            workspaceRoot: noninteractiveWorkspace,
            requestPermission: allowAllPermission,
            resolveSdkModel: throwingResolver,
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            sessionId: 'session_default_tools_noninteractive',
            projectTrustStore: trustedProjectTrustStore,
            lspServerManagerDeps: noLspServers,
        });
        registries.push(noninteractive);

        // Then
        expect(advertisedNames(interactive)).toEqual([
            'repo.read',
            'repo.list',
            'repo.search',
            'read',
            'ls',
            'grep',
            'find',
            'repo.read.tagged',
            'session_list',
            'session_read',
            'session_info',
            'session_search',
            'glob',
            'ripgrep',
            'ast_grep',
            'ast_edit',
            'resolve',
            'todowrite',
            'skill',
            'webfetch',
            'file.edit',
            'file.write',
            'file.patch',
            'hashline_edit',
            'command.run',
            'look_at',
            'inspect_image',
            'checkpoint',
            'rewind',
            'task',
        ]);
        expect(advertisedNames(noninteractive)).toEqual([
            'repo.read',
            'repo.list',
            'repo.search',
            'read',
            'ls',
            'grep',
            'find',
            'repo.read.tagged',
            'session_list',
            'session_read',
            'session_info',
            'session_search',
            'glob',
            'ripgrep',
            'ast_grep',
            'ast_edit',
            'resolve',
            'todowrite',
            'skill',
            'webfetch',
            'ask_user',
            'file.edit',
            'file.write',
            'file.patch',
            'hashline_edit',
            'command.run',
            'look_at',
            'inspect_image',
            'checkpoint',
            'rewind',
            'task',
        ]);
    });

    it('routes interactive setup through the shared missing-workspace guard', async () => {
        // Given
        const output = createBufferedChatOutput();

        // When
        const result = await settleRegistrySetup(
            createInteractiveToolRegistry(toolOptions(output.output, '', throwingResolver), fakeBroker()),
        );
        if (result.kind === 'resolved') registries.push(result.registry);

        // Then
        if (result.kind === 'rejected') expect(result.error).toBeInstanceOf(MissingWorkspaceRootError);
        expect(result).toMatchObject({
            kind: 'rejected',
            error: {
                name: 'MissingWorkspaceRootError',
                message: 'workspaceRoot is required to register default coding tools',
            },
        });
    });

    it('routes noninteractive setup through the shared missing-workspace guard', async () => {
        // Given
        const options = {
            workspaceRoot: '',
            requestPermission: allowAllPermission,
            resolveSdkModel: throwingResolver,
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            sessionId: 'session_default_tools_missing_workspace',
            projectTrustStore: trustedProjectTrustStore,
            lspServerManagerDeps: noLspServers,
        } as const;

        // When
        const result = await settleRegistrySetup(createNonInteractiveToolRegistry(options));
        if (result.kind === 'resolved') registries.push(result.registry);

        // Then
        if (result.kind === 'rejected') expect(result.error).toBeInstanceOf(MissingWorkspaceRootError);
        expect(result).toMatchObject({
            kind: 'rejected',
            error: {
                name: 'MissingWorkspaceRootError',
                message: 'workspaceRoot is required to register default coding tools',
            },
        });
    });
});

function advertisedNames(registry: ProductionToolRegistry): readonly string[] {
    return registry.registry.advertise().map((advertisement) => advertisement.name);
}

async function createTempRoot(tempRoots: string[], prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(root);
    return root;
}

async function settleRegistrySetup(setup: Promise<ProductionToolRegistry>) {
    return setup.then(
        (registry) => ({ kind: 'resolved', registry }) as const,
        (error: unknown) => ({ kind: 'rejected', error }) as const,
    );
}
