import { afterEach, describe, expect, it } from 'vitest';
import { registerReadOnlyRepoTools } from './read-tools.js';
import { ToolRegistry } from './tool-registry.js';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('read-only repo tools', () => {
    const workspaces: string[] = [];

    afterEach(async () => {
        await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
        workspaces.length = 0;
    });

    it('registers repo.read repo.list and repo.search advertisements', async () => {
        // Given
        const workspaceRoot = await createWorkspace();
        const registry = new ToolRegistry();

        // When
        const advertisements = await registerReadOnlyRepoTools(registry, { workspaceRoot });

        // Then
        expect(advertisements.map((tool) => tool.name)).toEqual(['repo.read', 'repo.list', 'repo.search']);
        expect(advertisements.map((tool) => tool.capabilityClasses)).toEqual([
            ['repo.read'],
            ['repo.read'],
            ['repo.read'],
        ]);
    });

    it('reads workspace files with truncation metadata', async () => {
        // Given
        const workspaceRoot = await createWorkspace();
        await writeFile(join(workspaceRoot, 'notes.txt'), '0123456789abcdef', 'utf8');
        const registry = await createRegistry(workspaceRoot, { maxReadBytes: 8 });
        const advertised = findAdvertisement(registry, 'repo.read');

        // When
        const settlement = await registry.invoke({
            toolCallId: 'read_truncated',
            toolName: 'repo.read',
            advertisedVersion: advertised.version,
            argumentsJson: JSON.stringify({ path: 'notes.txt' }),
        });

        // Then
        expect(settlement.result.status).toBe('completed');
        expect(settlement.structuredOutput).toMatchObject({
            kind: 'file',
            path: 'notes.txt',
            content: '01234567',
            truncated: true,
            originalBytes: 16,
            returnedBytes: 8,
        });
        expect(settlement.result.output).toContain('truncated');
    });

    it('rejects parent traversal and symlink escapes before reading', async () => {
        // Given
        const workspaceRoot = await createWorkspace();
        const outsideRoot = await createWorkspace();
        await writeFile(join(outsideRoot, 'secret.txt'), 'secret', 'utf8');
        await symlink(join(outsideRoot, 'secret.txt'), join(workspaceRoot, 'link.txt'));
        const registry = await createRegistry(workspaceRoot);
        const advertised = findAdvertisement(registry, 'repo.read');

        // When
        const traversal = await invokeRead(registry, advertised.version, '../secret.txt');
        const symlinkEscape = await invokeRead(registry, advertised.version, 'link.txt');

        // Then
        expect(traversal.result).toMatchObject({
            status: 'failed',
            error: { code: 'tool_failed' },
        });
        expect(traversal.result.error?.message).toContain('workspace_escape');
        expect(symlinkEscape.result.error?.message).toContain('workspace_escape');
    });

    it('rejects symlink escapes through parent path components for every read-only tool', async () => {
        // Given
        const workspaceRoot = await createWorkspace();
        const outsideRoot = await createWorkspace();
        await mkdir(join(outsideRoot, 'nested'));
        await writeFile(join(outsideRoot, 'nested', 'secret.txt'), 'outside-secret', 'utf8');
        await symlink(join(outsideRoot, 'nested'), join(workspaceRoot, 'linked-dir'));
        await symlink(outsideRoot, join(workspaceRoot, 'linked-root'));
        const registry = await createRegistry(workspaceRoot);
        const readTool = findAdvertisement(registry, 'repo.read');
        const listTool = findAdvertisement(registry, 'repo.list');
        const searchTool = findAdvertisement(registry, 'repo.search');

        // When
        const read = await invokeRead(registry, readTool.version, 'linked-dir/secret.txt');
        const list = await registry.invoke({
            toolCallId: 'list_symlink_parent',
            toolName: 'repo.list',
            advertisedVersion: listTool.version,
            argumentsJson: JSON.stringify({ path: 'linked-root/nested' }),
        });
        const search = await registry.invoke({
            toolCallId: 'search_symlink_parent',
            toolName: 'repo.search',
            advertisedVersion: searchTool.version,
            argumentsJson: JSON.stringify({ pattern: 'outside-secret', path: 'linked-dir/secret.txt' }),
        });

        // Then
        expect(read.result).toMatchObject({ status: 'failed', error: { code: 'tool_failed' } });
        expect(list.result).toMatchObject({ status: 'failed', error: { code: 'tool_failed' } });
        expect(search.result).toMatchObject({ status: 'failed', error: { code: 'tool_failed' } });
        expect(read.result.error?.message).toContain('workspace_escape');
        expect(list.result.error?.message).toContain('workspace_escape');
        expect(search.result.error?.message).toContain('workspace_escape');
    });

    it('returns typed failures for missing and binary files', async () => {
        // Given
        const workspaceRoot = await createWorkspace();
        await writeFile(join(workspaceRoot, 'image.bin'), Buffer.from([0, 1, 2, 3]));
        const registry = await createRegistry(workspaceRoot);
        const advertised = findAdvertisement(registry, 'repo.read');

        // When
        const missing = await invokeRead(registry, advertised.version, 'missing.txt');
        const binary = await invokeRead(registry, advertised.version, 'image.bin');

        // Then
        expect(missing.result.error?.message).toContain('not_found');
        expect(binary.result.error?.message).toContain('binary_file');
    });

    it('lists workspace directories with entry bounds', async () => {
        // Given
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'src'));
        await writeFile(join(workspaceRoot, 'b.txt'), 'b', 'utf8');
        await writeFile(join(workspaceRoot, 'a.txt'), 'a', 'utf8');
        const registry = await createRegistry(workspaceRoot, { maxListEntries: 2 });
        const advertised = findAdvertisement(registry, 'repo.list');

        // When
        const settlement = await registry.invoke({
            toolCallId: 'list_root',
            toolName: 'repo.list',
            advertisedVersion: advertised.version,
            argumentsJson: JSON.stringify({ path: '.' }),
        });

        // Then
        expect(settlement.structuredOutput).toMatchObject({
            kind: 'directory',
            path: '.',
            entries: [
                { name: 'a.txt', kind: 'file' },
                { name: 'b.txt', kind: 'file' },
            ],
            truncated: true,
            totalEntries: 3,
        });
    });

    it('searches text files with match and line bounds', async () => {
        // Given
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'src'));
        await writeFile(join(workspaceRoot, 'src', 'a.ts'), 'needle one\nneedle two is a long line', 'utf8');
        await writeFile(join(workspaceRoot, 'src', 'b.ts'), 'needle three', 'utf8');
        const registry = await createRegistry(workspaceRoot, { maxSearchLineChars: 10, maxSearchMatches: 2 });
        const advertised = findAdvertisement(registry, 'repo.search');

        // When
        const settlement = await registry.invoke({
            toolCallId: 'search_needles',
            toolName: 'repo.search',
            advertisedVersion: advertised.version,
            argumentsJson: JSON.stringify({ pattern: 'needle', path: 'src' }),
        });

        // Then
        expect(settlement.structuredOutput).toMatchObject({
            kind: 'search',
            pattern: 'needle',
            truncated: true,
            totalMatches: 3,
            matches: [
                { path: 'src/a.ts', line: 1, text: 'needle one', textTruncated: false },
                { path: 'src/a.ts', line: 2, text: 'needle ...', textTruncated: true },
            ],
        });
    });

    async function createWorkspace(): Promise<string> {
        const workspace = await mkdtemp(join(tmpdir(), 'mctrl-read-tools-'));
        workspaces.push(workspace);
        return workspace;
    }
});

type ReadToolOptions = Parameters<typeof registerReadOnlyRepoTools>[1];

async function createRegistry(workspaceRoot: string, options: Partial<ReadToolOptions> = {}): Promise<ToolRegistry> {
    const registry = new ToolRegistry();
    await registerReadOnlyRepoTools(registry, { ...options, workspaceRoot });
    return registry;
}

function findAdvertisement(registry: ToolRegistry, name: string) {
    const advertisement = registry.advertise().find((tool) => tool.name === name);
    if (advertisement === undefined) {
        throw new TypeError(`missing advertisement: ${name}`);
    }
    return advertisement;
}

async function invokeRead(registry: ToolRegistry, advertisedVersion: string, path: string) {
    return registry.invoke({
        toolCallId: `read_${path.replaceAll(/[^a-z0-9]+/gi, '_')}`,
        toolName: 'repo.read',
        advertisedVersion,
        argumentsJson: JSON.stringify({ path }),
    });
}
