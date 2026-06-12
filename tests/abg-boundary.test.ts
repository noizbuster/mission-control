import { afterEach, describe, expect, it } from 'vitest';
import { registerReadOnlyRepoTools, ToolRegistry } from '../packages/core/src/index.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const workspaces: string[] = [];

function collectSourceFiles(dir: string): string[] {
    const absoluteDir = join(root, dir);
    const files: string[] = [];
    for (const entry of readdirSync(absoluteDir)) {
        const path = join(absoluteDir, entry);
        const stat = statSync(path);
        if (stat.isDirectory()) {
            files.push(...collectSourceFiles(path.slice(root.length + 1)));
            continue;
        }
        if (path.endsWith('.ts') || path.endsWith('.tsx')) {
            files.push(path);
        }
    }
    return files;
}

describe('ABG runtime boundaries', () => {
    afterEach(async () => {
        await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
        workspaces.length = 0;
    });

    it('core runtime has no imports from CLI desktop or React UI', () => {
        const forbidden = ['apps/cli', 'apps/desktop', '@mission-control/cli', '@mission-control/desktop', 'react'];

        for (const file of collectSourceFiles('packages/core/src')) {
            const source = readFileSync(file, 'utf8');
            for (const term of forbidden) {
                expect(source, `${file} must not depend on ${term}`).not.toContain(term);
            }
        }
    });

    it('reference repos are planning evidence only', async () => {
        const sentinel = 'REFERENCE_REPO_SENTINEL_DO_NOT_LEAK';
        const injectedDirective = `agent directive ${sentinel}`;
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'temp', 'ref-repos', 'opencode'), { recursive: true });
        await mkdir(join(workspaceRoot, 'temp'), { recursive: true });
        await writeFile(join(workspaceRoot, 'temp', 'ref-repos', 'opencode', 'AGENTS.md'), injectedDirective, 'utf8');
        await writeFile(join(workspaceRoot, 'temp', 'notes.txt'), 'ordinary workspace file', 'utf8');

        const registry = new ToolRegistry();
        await registerReadOnlyRepoTools(registry, { workspaceRoot });
        const readTool = findAdvertisement(registry, 'repo.read');
        const listTool = findAdvertisement(registry, 'repo.list');
        const searchTool = findAdvertisement(registry, 'repo.search');

        const deniedRead = await invokeTool(registry, 'repo.read', readTool.version, {
            path: 'temp/ref-repos/opencode/AGENTS.md',
        });
        const tempListing = await invokeTool(registry, 'repo.list', listTool.version, { path: 'temp' });
        const rootSearch = await invokeTool(registry, 'repo.search', searchTool.version, {
            pattern: sentinel,
            path: '.',
        });
        const deniedScopedSearch = await invokeTool(registry, 'repo.search', searchTool.version, {
            pattern: sentinel,
            path: 'temp/ref-repos',
        });

        expect(deniedRead.result.status).toBe('failed');
        expect(deniedRead.result.error?.message).toContain('workspace_denied');
        expect(tempListing.result.status).toBe('completed');
        expect(tempListing.structuredOutput).toMatchObject({
            kind: 'directory',
            path: 'temp',
            entries: [{ name: 'notes.txt', kind: 'file' }],
            totalEntries: 1,
        });
        expect(tempListing.result.output).not.toContain('ref-repos');
        expect(rootSearch.result.status).toBe('completed');
        expect(rootSearch.result.output).not.toContain(injectedDirective);
        expect(rootSearch.structuredOutput).toMatchObject({
            kind: 'search',
            path: '.',
            totalMatches: 0,
            matches: [],
        });
        expect(deniedScopedSearch.result.status).toBe('failed');
        expect(deniedScopedSearch.result.error?.message).toContain('workspace_denied');
    });
});

async function createWorkspace(): Promise<string> {
    const workspace = await mkdtemp(join(tmpdir(), 'mctrl-abg-boundary-'));
    workspaces.push(workspace);
    return workspace;
}

function findAdvertisement(registry: ToolRegistry, name: string) {
    const advertisement = registry.advertise().find((tool) => tool.name === name);
    if (advertisement === undefined) {
        throw new TypeError(`missing advertisement: ${name}`);
    }
    return advertisement;
}

async function invokeTool(
    registry: ToolRegistry,
    toolName: 'repo.read' | 'repo.list' | 'repo.search',
    advertisedVersion: string,
    input: { readonly path: string; readonly pattern?: string },
) {
    return registry.invoke({
        toolCallId: `${toolName}_${input.path.replace(/[^a-z0-9]+/gi, '_')}`,
        toolName,
        advertisedVersion,
        argumentsJson: JSON.stringify(input),
    });
}
