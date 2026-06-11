import { afterEach, describe, expect, it } from 'vitest';
import { registerReadOnlyRepoTools } from './read-tools.js';
import { createWorkspaceGuard } from './read-tools-paths.js';
import { ToolRegistry } from './tool-registry.js';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('read-only repo tool denylist', () => {
    const workspaces: string[] = [];

    afterEach(async () => {
        await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
        workspaces.length = 0;
    });

    it('denies generated and reference paths unless explicitly allowed', async () => {
        const workspaceRoot = await createWorkspace();
        await createDenylistFixture(workspaceRoot);
        const defaultRegistry = await createRegistry(workspaceRoot);
        const readTool = findAdvertisement(defaultRegistry, 'repo.read');
        const listTool = findAdvertisement(defaultRegistry, 'repo.list');
        const searchTool = findAdvertisement(defaultRegistry, 'repo.search');

        const deniedRead = await invokeRead(defaultRegistry, readTool.version, 'temp/ref-repos/opencode/README.md');
        const deniedList = await invokeList(defaultRegistry, listTool.version, 'dist');
        const deniedSearchPath = await invokeSearch(defaultRegistry, searchTool.version, 'hidden needle', '.nx');
        const rootSearch = await invokeSearch(defaultRegistry, searchTool.version, 'needle', '.');
        const allowedRegistry = await createRegistry(workspaceRoot, {
            allowDenylistedPaths: ['temp/ref-repos/opencode'],
        });
        const allowedReadTool = findAdvertisement(allowedRegistry, 'repo.read');
        const stillDenied = await invokeRead(allowedRegistry, allowedReadTool.version, 'dist/bundle.txt');
        const allowedRead = await invokeRead(
            allowedRegistry,
            allowedReadTool.version,
            'temp/ref-repos/opencode/README.md',
        );

        expect(deniedRead.result.error?.message).toContain('workspace_denied');
        expect(deniedList.result.error?.message).toContain('workspace_denied');
        expect(deniedSearchPath.result.error?.message).toContain('workspace_denied');
        expect(rootSearch.structuredOutput).toMatchObject({
            totalMatches: 1,
            matches: [{ path: 'visible.txt' }],
        });
        expect(stillDenied.result.error?.message).toContain('workspace_denied');
        expect(allowedRead.structuredOutput).toMatchObject({
            path: 'temp/ref-repos/opencode/README.md',
            content: 'hidden needle',
        });
    });

    it('generates ripgrep globs that exclude multi-segment deny entries for absolute targets', async () => {
        const workspaceRoot = await createWorkspace();
        await createDenylistFixture(workspaceRoot);
        await mkdir(join(workspaceRoot, '.omo', 'evidence'), { recursive: true });
        await writeFile(join(workspaceRoot, '.omo', 'evidence', 'log.txt'), 'hidden needle', 'utf8');
        const guard = await createWorkspaceGuard(workspaceRoot);
        const rgResult = await runRipgrep([
            '--json',
            '--line-number',
            '--color=never',
            '--hidden',
            '--no-messages',
            ...guard.denylistRipgrepGlobs.flatMap((glob) => ['--glob', glob]),
            '--',
            'needle',
            workspaceRoot,
        ]);

        expect(rgResult.code).toBe(0);
        expect(rgResult.stdout).toContain('visible.txt');
        expect(rgResult.stdout).not.toContain('temp/ref-repos');
        expect(rgResult.stdout).not.toContain('.omo/evidence');
    });

    it('rejects broad allow entries that would unlock unrelated denied paths', async () => {
        const workspaceRoot = await createWorkspace();
        await createDenylistFixture(workspaceRoot);

        await expect(createRegistry(workspaceRoot, { allowDenylistedPaths: ['.'] })).rejects.toThrow(
            'workspace_denied',
        );
        await expect(createRegistry(workspaceRoot, { allowDenylistedPaths: ['temp'] })).rejects.toThrow(
            'workspace_denied',
        );
    });

    async function createWorkspace(): Promise<string> {
        const workspace = await mkdtemp(join(tmpdir(), 'mctrl-read-tools-'));
        workspaces.push(workspace);
        return workspace;
    }
});

type ReadToolOptions = Parameters<typeof registerReadOnlyRepoTools>[1];

async function createDenylistFixture(workspaceRoot: string): Promise<void> {
    await mkdir(join(workspaceRoot, 'temp', 'ref-repos', 'opencode'), { recursive: true });
    await mkdir(join(workspaceRoot, '.nx'), { recursive: true });
    await mkdir(join(workspaceRoot, 'dist'), { recursive: true });
    await writeFile(join(workspaceRoot, 'temp', 'ref-repos', 'opencode', 'README.md'), 'hidden needle', 'utf8');
    await writeFile(join(workspaceRoot, '.nx', 'cache.txt'), 'hidden needle', 'utf8');
    await writeFile(join(workspaceRoot, 'dist', 'bundle.txt'), 'hidden needle', 'utf8');
    await writeFile(join(workspaceRoot, 'visible.txt'), 'visible needle', 'utf8');
}

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

async function invokeList(registry: ToolRegistry, advertisedVersion: string, path: string) {
    return registry.invoke({
        toolCallId: `list_${path.replaceAll(/[^a-z0-9]+/gi, '_')}`,
        toolName: 'repo.list',
        advertisedVersion,
        argumentsJson: JSON.stringify({ path }),
    });
}

async function invokeSearch(registry: ToolRegistry, advertisedVersion: string, pattern: string, path: string) {
    return registry.invoke({
        toolCallId: `search_${path.replaceAll(/[^a-z0-9]+/gi, '_')}`,
        toolName: 'repo.search',
        advertisedVersion,
        argumentsJson: JSON.stringify({ pattern, path }),
    });
}

function runRipgrep(
    args: readonly string[],
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        child.on('error', rejectPromise);
        child.on('close', (code) =>
            resolvePromise({
                code: code ?? 1,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
            }),
        );
    });
}
