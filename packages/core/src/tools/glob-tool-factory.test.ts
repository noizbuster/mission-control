import { afterEach, describe, expect, it } from 'vitest';
import { registerGlobTool } from './glob-tool-factory.js';
import { ToolRegistry } from './tool-registry.js';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('workspace-scoped glob factory', () => {
    const workspaces: string[] = [];

    afterEach(async () => {
        await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
        workspaces.length = 0;
    });

    it('returns workspace-relative matches under the workspace root', async () => {
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'src'), { recursive: true });
        await writeFile(join(workspaceRoot, 'src', 'a.ts'), 'x', 'utf8');
        await writeFile(join(workspaceRoot, 'src', 'b.json'), '{}', 'utf8');
        const registry = await buildRegistry(workspaceRoot);

        const settlement = await invokeGlob(registry, { pattern: '**/*.ts' });

        expect(settlement.result.status).toBe('completed');
        const output = settlement.structuredOutput as { paths: readonly string[] };
        expect(output.paths).toContain('src/a.ts');
        expect(output.paths.some((path) => path.includes('..'))).toBe(false);
    });

    it('rejects an absolute base that targets outside the workspace', async () => {
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'src'), { recursive: true });
        const outside = await mkdtemp(join(tmpdir(), 'mctrl-glob-outside-'));
        workspaces.push(outside);
        await writeFile(join(outside, 'secret.txt'), 'leaked', 'utf8');
        const registry = await buildRegistry(workspaceRoot);

        const settlement = await invokeGlob(registry, { pattern: '*.txt', path: outside });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('workspace_escape');
        expect(JSON.stringify(settlement)).not.toContain('leaked');
    });

    it('rejects a symlink that escapes the workspace', async () => {
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'src'), { recursive: true });
        const outside = await mkdtemp(join(tmpdir(), 'mctrl-glob-symlink-'));
        workspaces.push(outside);
        await writeFile(join(outside, 'escaped.txt'), 'LEAKED_VIA_SYMLINK', 'utf8');
        await symlink(outside, join(workspaceRoot, 'escape-link'));
        const registry = await buildRegistry(workspaceRoot);

        const settlement = await invokeGlob(registry, { pattern: '**/*.txt', path: 'escape-link' });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('workspace_escape');
        expect(JSON.stringify(settlement)).not.toContain('LEAKED_VIA_SYMLINK');
    });

    it('filters temp/ref-repos matches out of results (same denylist as read tools)', async () => {
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'temp', 'ref-repos', 'opencode'), { recursive: true });
        await mkdir(join(workspaceRoot, 'src'), { recursive: true });
        await writeFile(join(workspaceRoot, 'temp', 'ref-repos', 'opencode', 'README.md'), 'ref', 'utf8');
        await writeFile(join(workspaceRoot, 'src', 'app.ts'), 'app', 'utf8');
        const registry = await buildRegistry(workspaceRoot);

        const settlement = await invokeGlob(registry, { pattern: '**/*.md' });
        const output = settlement.structuredOutput as { paths: readonly string[] };

        expect(settlement.result.status).toBe('completed');
        expect(output.paths.some((path) => path.includes('temp/ref-repos'))).toBe(false);
        expect(output.paths.some((path) => path.includes('temp'))).toBe(false);
    });

    it('denies a glob base directly inside temp/ref-repos', async () => {
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'temp', 'ref-repos', 'opencode'), { recursive: true });
        await writeFile(join(workspaceRoot, 'temp', 'ref-repos', 'opencode', 'README.md'), 'ref', 'utf8');
        const registry = await buildRegistry(workspaceRoot);

        const settlement = await invokeGlob(registry, {
            pattern: '*.md',
            path: 'temp/ref-repos/opencode',
        });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('workspace_denied');
    });

    it('rejects a malformed invocation (missing pattern) before walking the workspace', async () => {
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'src'), { recursive: true });
        const registry = await buildRegistry(workspaceRoot);
        const advertisement = registry.advertise().find((tool) => tool.name === 'glob');
        if (advertisement === undefined) {
            throw new TypeError('glob not registered');
        }

        const settlement = await registry.invoke({
            toolCallId: 'glob_malformed',
            toolName: 'glob',
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify({ path: 'src' }),
        });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.code).toBe('schema_invalid');
    });

    async function createWorkspace(): Promise<string> {
        const workspace = await mkdtemp(join(tmpdir(), 'mctrl-glob-factory-'));
        workspaces.push(workspace);
        return workspace;
    }

    async function buildRegistry(workspaceRoot: string): Promise<ToolRegistry> {
        const registry = new ToolRegistry();
        await registerGlobTool(registry, { workspaceRoot });
        return registry;
    }

    async function invokeGlob(
        registry: ToolRegistry,
        input: { readonly pattern: string; readonly path?: string; readonly maxResults?: number },
    ) {
        const advertisement = registry.advertise().find((tool) => tool.name === 'glob');
        if (advertisement === undefined) {
            throw new TypeError('glob not registered');
        }
        return registry.invoke({
            toolCallId: 'glob_factory_call',
            toolName: 'glob',
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify(input),
        });
    }
});
