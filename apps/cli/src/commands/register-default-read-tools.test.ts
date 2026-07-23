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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const READ_TOOL_NAMES = [
    'repo.read',
    'repo.list',
    'repo.search',
    'read',
    'ls',
    'grep',
    'find',
    'repo.read.tagged',
] as const;

describe('default production read tool surface', () => {
    const tempRoots: string[] = [];
    const registries: ProductionToolRegistry[] = [];

    afterEach(async () => {
        await Promise.all(registries.map((registry) => closeProductionToolRegistry(registry)));
        registries.length = 0;
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('advertises all read names and permits safe plus reference-repo reads in both modes', async () => {
        // Given
        const configRoot = await createTempRoot(tempRoots, 'mctrl-read-surface-config-');
        const dataRoot = await createTempRoot(tempRoots, 'mctrl-read-surface-data-');
        const workspaceRoot = await createTempRoot(tempRoots, 'mctrl-read-surface-workspace-');
        await writeFile(join(workspaceRoot, 'safe.txt'), 'safe content\n', 'utf8');
        await mkdir(join(workspaceRoot, 'temp', 'ref-repos', 'fixture'), { recursive: true });
        await writeFile(join(workspaceRoot, 'temp', 'ref-repos', 'fixture', 'README.md'), 'inspectable\n', 'utf8');
        vi.stubEnv('MCTRL_CONFIG_DIR', configRoot);
        vi.stubEnv('MCTRL_DATA_DIR', dataRoot);
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('PARALLEL_API_KEY', '');
        const output = createBufferedChatOutput();
        const interactive = await createInteractiveToolRegistry(
            toolOptions(output.output, workspaceRoot),
            fakeBroker(),
        );
        registries.push(interactive);
        const noninteractive = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowAllPermission,
            projectTrustStore: trustedProjectTrustStore,
            lspServerManagerDeps: noLspServers,
        });
        registries.push(noninteractive);

        // When
        const settlements = await Promise.all(
            [interactive, noninteractive].flatMap((registry) => [
                invokeRead(registry, 'read', 'safe.txt'),
                invokeRead(registry, 'repo.read', 'safe.txt'),
                invokeRead(registry, 'read', 'temp/ref-repos/fixture/README.md'),
                invokeRead(registry, 'repo.read', 'temp/ref-repos/fixture/README.md'),
            ]),
        );

        // Then
        expect(readNames(interactive)).toEqual(READ_TOOL_NAMES);
        expect(readNames(noninteractive)).toEqual(READ_TOOL_NAMES);
        for (const settlement of settlements) {
            expect(settlement.result.status).toBe('completed');
        }
        for (const settlement of [settlements[2], settlements[3], settlements[6], settlements[7]]) {
            expect(settlement?.structuredOutput).toMatchObject({
                kind: 'file',
                path: 'temp/ref-repos/fixture/README.md',
                content: 'inspectable\n',
            });
        }
    });
});

async function createTempRoot(tempRoots: string[], prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(root);
    return root;
}

function readNames(registry: ProductionToolRegistry): readonly string[] {
    return registry.registry
        .advertise()
        .map((tool) => tool.name)
        .filter((name) => READ_TOOL_NAMES.some((readToolName) => readToolName === name));
}

async function invokeRead(registry: ProductionToolRegistry, toolName: 'read' | 'repo.read', path: string) {
    const advertisement = registry.registry.advertise().find((tool) => tool.name === toolName);
    if (advertisement === undefined) throw new TypeError(`${toolName} was not advertised`);
    return registry.registry.invoke({
        toolCallId: `${toolName.replace('.', '_')}_${path.startsWith('safe') ? 'safe' : 'reference_repo'}`,
        toolName,
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify({ path }),
    });
}
