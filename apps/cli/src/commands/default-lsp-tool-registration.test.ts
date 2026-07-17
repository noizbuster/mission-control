import { InProcessLspClient } from '@mission-control/core';
import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InteractiveApprovalBroker } from './interactive-approval-broker';
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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

describe('default LSP tool registration', () => {
    const tempRoots: string[] = [];
    const registries: ProductionToolRegistry[] = [];

    beforeEach(async () => {
        const configRoot = await createTempRoot(tempRoots, 'mctrl-lsp-config-');
        const dataRoot = await createTempRoot(tempRoots, 'mctrl-lsp-data-');
        vi.stubEnv('MCTRL_CONFIG_DIR', configRoot);
        vi.stubEnv('MCTRL_DATA_DIR', dataRoot);
    });

    afterEach(async () => {
        await Promise.all(registries.map((registry) => closeProductionToolRegistry(registry)));
        registries.length = 0;
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('advertises the read and rename tools together when an LSP client is available', async () => {
        // Given
        const workspaceRoot = await createTempRoot(tempRoots, 'mctrl-lsp-client-');
        const output = createBufferedChatOutput();
        const uri = pathToFileURL(join(workspaceRoot, 'sample.ts')).href;

        // When
        const registry = await createInteractiveToolRegistry(
            toolOptions(output.output, workspaceRoot, undefined, new RenameCapableLspClient(uri)),
            fakeBroker(),
        );
        registries.push(registry);

        // Then
        expect(lspAdvertisements(registry)).toEqual([
            { name: 'lsp', capabilityClasses: ['read'] },
            { name: 'lsp_rename', capabilityClasses: ['write'] },
        ]);
    });

    it('advertises the read and rename tools together when the server gate succeeds', async () => {
        // Given
        const workspaceRoot = await createTempRoot(tempRoots, 'mctrl-lsp-server-');

        // When
        const registry = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowAllPermission,
            projectTrustStore: trustedProjectTrustStore,
            lspServerManagerDeps: { commandExists: async () => true },
        });
        registries.push(registry);

        // Then
        expect(lspAdvertisements(registry)).toEqual([
            { name: 'lsp', capabilityClasses: ['read'] },
            { name: 'lsp_rename', capabilityClasses: ['write'] },
        ]);
    });

    it('advertises neither tool when no LSP client or server is available', async () => {
        // Given
        const workspaceRoot = await createTempRoot(tempRoots, 'mctrl-no-lsp-');

        // When
        const registry = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowAllPermission,
            projectTrustStore: trustedProjectTrustStore,
            lspServerManagerDeps: noLspServers,
        });
        registries.push(registry);

        // Then
        expect(lspAdvertisements(registry)).toEqual([]);
    });

    it('applies an approved rename through the production registry', async () => {
        // Given
        const workspaceRoot = await createTempRoot(tempRoots, 'mctrl-lsp-allow-');
        const filePath = join(workspaceRoot, 'sample.ts');
        const uri = pathToFileURL(filePath).href;
        const requests: PermissionRequest[] = [];
        await writeFile(filePath, 'const foo = foo;\n', 'utf8');
        const output = createBufferedChatOutput();
        const broker = brokerWithPermission(async (request): Promise<PermissionDecision> => {
            requests.push(request);
            return { requestId: request.id, status: 'allow' };
        });
        const registry = await createInteractiveToolRegistry(
            toolOptions(output.output, workspaceRoot, undefined, new RenameCapableLspClient(uri)),
            broker,
        );
        registries.push(registry);

        // When
        const settlement = await invokeRename(registry, uri, 'bar');

        // Then
        expect(settlement.result.status).toBe('completed');
        expect(settlement.structuredOutput).toMatchObject({ status: 'applied', fileCount: 1, editCount: 1 });
        expect(await readFile(filePath, 'utf8')).toBe('const bar = foo;\n');
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
            action: 'lsp_rename',
            permission: { kind: 'edit', patterns: [uri], workspaceRoot },
        });
    });

    it('prevents a denied rename through the production registry', async () => {
        // Given
        const workspaceRoot = await createTempRoot(tempRoots, 'mctrl-lsp-deny-');
        const filePath = join(workspaceRoot, 'sample.ts');
        const uri = pathToFileURL(filePath).href;
        const requests: PermissionRequest[] = [];
        await writeFile(filePath, 'const foo = foo;\n', 'utf8');
        const output = createBufferedChatOutput();
        const broker = brokerWithPermission(async (request): Promise<PermissionDecision> => {
            requests.push(request);
            return { requestId: request.id, status: 'deny', reason: 'rename denied by test' };
        });
        const registry = await createInteractiveToolRegistry(
            toolOptions(output.output, workspaceRoot, undefined, new RenameCapableLspClient(uri)),
            broker,
        );
        registries.push(registry);

        // When
        const settlement = await invokeRename(registry, uri, 'bar');

        // Then
        expect(settlement.result).toMatchObject({
            status: 'failed',
            error: { code: 'tool_failed', message: 'lsp_rename: rename denied by test' },
        });
        expect(await readFile(filePath, 'utf8')).toBe('const foo = foo;\n');
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
            action: 'lsp_rename',
            permission: { kind: 'edit', patterns: [uri], workspaceRoot },
        });
    });
});

class RenameCapableLspClient extends InProcessLspClient {
    constructor(private readonly targetUri: string) {
        super({});
    }

    async prepareRename(uri: string, line: number, character: number) {
        if (uri !== this.targetUri) return undefined;
        return {
            range: { start: { line, character }, end: { line, character: character + 3 } },
            placeholder: 'foo',
        };
    }

    async rename(uri: string, line: number, character: number, newName: string) {
        if (uri !== this.targetUri) return undefined;
        return {
            changes: {
                [uri]: [
                    {
                        range: { start: { line, character }, end: { line, character: character + 3 } },
                        newText: newName,
                    },
                ],
            },
        };
    }
}

function lspAdvertisements(registry: ProductionToolRegistry) {
    return registry.registry
        .advertise()
        .filter((advertisement) => advertisement.name === 'lsp' || advertisement.name === 'lsp_rename')
        .map(({ name, capabilityClasses }) => ({ name, capabilityClasses }));
}

function brokerWithPermission(
    requestPermission: InteractiveApprovalBroker['requestPermission'],
): InteractiveApprovalBroker {
    return { ...fakeBroker(), requestPermission };
}

async function invokeRename(registry: ProductionToolRegistry, uri: string, newName: string) {
    const advertisement = registry.registry.advertise().find((candidate) => candidate.name === 'lsp_rename');
    if (advertisement === undefined) throw new Error('lsp_rename was not advertised');
    return registry.registry.invoke({
        toolCallId: `rename-${newName}`,
        toolName: advertisement.name,
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify({ uri, line: 0, character: 6, newName }),
    });
}

async function createTempRoot(tempRoots: string[], prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(root);
    return root;
}
