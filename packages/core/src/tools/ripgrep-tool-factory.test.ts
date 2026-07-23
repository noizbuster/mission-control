import { afterEach, describe, expect, it } from 'vitest';
import { registerRipgrepTool } from './ripgrep-tool-factory';
import { ToolRegistry } from './tool-registry';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rgAvailable = (() => {
    try {
        const result = spawnSync('rg', ['--version'], { encoding: 'utf8', shell: false });
        return result.status === 0;
    } catch {
        return false;
    }
})();

const describeWithRg = rgAvailable ? describe : describe.skip;

describeWithRg('workspace-scoped ripgrep factory', () => {
    const workspaces: string[] = [];

    afterEach(async () => {
        await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
        workspaces.length = 0;
    });

    it('returns content matches under the workspace root in output_mode=content', async () => {
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'src'), { recursive: true });
        await writeFile(join(workspaceRoot, 'src', 'a.ts'), 'export const alpha = 1\nexport const beta = 2\n', 'utf8');
        await writeFile(join(workspaceRoot, 'src', 'b.ts'), 'export const gamma = 3\n', 'utf8');
        const registry = await buildRegistry(workspaceRoot);

        const settlement = await invokeRipgrep(registry, {
            pattern: 'alpha|beta',
            output_mode: 'content',
        });

        expect(settlement.result.status).toBe('completed');
        const output = settlement.structuredOutput as {
            matches: ReadonlyArray<{ path: string; line: number; text: string }>;
        };
        const lines = output.matches.map((match) => `${match.path}:${match.line}:${match.text.trim()}`);
        expect(lines).toContain('src/a.ts:1:export const alpha = 1');
        expect(lines).toContain('src/a.ts:2:export const beta = 2');
        expect(output.matches.some((match) => match.path.includes('..'))).toBe(false);
    });

    it('returns file paths in output_mode=files_with_matches (default)', async () => {
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'src'), { recursive: true });
        await writeFile(join(workspaceRoot, 'src', 'a.ts'), 'needle\n', 'utf8');
        await writeFile(join(workspaceRoot, 'src', 'b.ts'), 'nothing\n', 'utf8');
        const registry = await buildRegistry(workspaceRoot);

        const settlement = await invokeRipgrep(registry, { pattern: 'needle' });

        expect(settlement.result.status).toBe('completed');
        const output = settlement.structuredOutput as {
            matches: ReadonlyArray<{ path: string; line: number; text: string }>;
        };
        const paths = output.matches.map((match) => match.path);
        expect(paths).toContain('src/a.ts');
        expect(paths).not.toContain('src/b.ts');
    });

    it('respects include glob filter', async () => {
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'src'), { recursive: true });
        await writeFile(join(workspaceRoot, 'src', 'a.ts'), 'needle\n', 'utf8');
        await writeFile(join(workspaceRoot, 'src', 'b.json'), 'needle\n', 'utf8');
        const registry = await buildRegistry(workspaceRoot);

        const settlement = await invokeRipgrep(registry, {
            pattern: 'needle',
            include: '*.ts',
        });

        expect(settlement.result.status).toBe('completed');
        const output = settlement.structuredOutput as {
            matches: ReadonlyArray<{ path: string; line: number; text: string }>;
        };
        const paths = output.matches.map((match) => match.path);
        expect(paths).toContain('src/a.ts');
        expect(paths).not.toContain('src/b.json');
    });

    it('returns No matches when pattern matches nothing', async () => {
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'src'), { recursive: true });
        await writeFile(join(workspaceRoot, 'src', 'a.ts'), 'alpha\n', 'utf8');
        const registry = await buildRegistry(workspaceRoot);

        const settlement = await invokeRipgrep(registry, { pattern: 'does-not-exist-anywhere' });

        expect(settlement.result.status).toBe('completed');
        expect(settlement.result.output).toContain('No matches');
    });

    it('rejects an absolute base that targets outside the workspace', async () => {
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'src'), { recursive: true });
        const outside = await mkdtemp(join(tmpdir(), 'mctrl-rg-outside-'));
        workspaces.push(outside);
        await writeFile(join(outside, 'secret.txt'), 'leaked', 'utf8');
        const registry = await buildRegistry(workspaceRoot);

        const settlement = await invokeRipgrep(registry, {
            pattern: 'leaked',
            path: outside,
        });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('workspace_escape');
        expect(JSON.stringify(settlement)).not.toContain('leaked');
    });

    it('rejects a symlink that escapes the workspace', async () => {
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'src'), { recursive: true });
        const outside = await mkdtemp(join(tmpdir(), 'mctrl-rg-symlink-'));
        workspaces.push(outside);
        await writeFile(join(outside, 'escaped.txt'), 'LEAKED_VIA_SYMLINK', 'utf8');
        await symlink(outside, join(workspaceRoot, 'escape-link'));
        const registry = await buildRegistry(workspaceRoot);

        const settlement = await invokeRipgrep(registry, {
            pattern: 'LEAKED',
            path: 'escape-link',
        });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.message).toContain('workspace_escape');
        expect(JSON.stringify(settlement)).not.toContain('LEAKED_VIA_SYMLINK');
    });

    it('includes temp/ref-repos matches', async () => {
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'temp', 'ref-repos', 'opencode'), { recursive: true });
        await mkdir(join(workspaceRoot, 'src'), { recursive: true });
        await writeFile(join(workspaceRoot, 'temp', 'ref-repos', 'opencode', 'README.md'), 'needle', 'utf8');
        await writeFile(join(workspaceRoot, 'src', 'app.ts'), 'needle', 'utf8');
        const registry = await buildRegistry(workspaceRoot);

        const settlement = await invokeRipgrep(registry, { pattern: 'needle' });

        expect(settlement.result.status).toBe('completed');
        const output = settlement.structuredOutput as {
            matches: ReadonlyArray<{ path: string; line: number; text: string }>;
        };
        const paths = output.matches.map((match) => match.path);
        expect(paths).toContain('temp/ref-repos/opencode/README.md');
    });

    it('allows a ripgrep base directly inside temp/ref-repos', async () => {
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'temp', 'ref-repos', 'opencode'), { recursive: true });
        await writeFile(join(workspaceRoot, 'temp', 'ref-repos', 'opencode', 'README.md'), 'needle', 'utf8');
        const registry = await buildRegistry(workspaceRoot);

        const settlement = await invokeRipgrep(registry, {
            pattern: 'needle',
            path: 'temp/ref-repos/opencode',
        });

        expect(settlement.result.status).toBe('completed');
        expect(settlement.structuredOutput).toMatchObject({
            matches: [expect.objectContaining({ path: 'temp/ref-repos/opencode/README.md' })],
        });
    });

    it('allows a ripgrep base inside nested node_modules', async () => {
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'apps', 'tui', 'node_modules', '@opentui', 'solid'), { recursive: true });
        await writeFile(
            join(workspaceRoot, 'apps', 'tui', 'node_modules', '@opentui', 'solid', 'index.ts'),
            'NESTED_DEPENDENCY_NEEDLE',
            'utf8',
        );
        const registry = await buildRegistry(workspaceRoot);

        const settlement = await invokeRipgrep(registry, {
            pattern: 'NESTED_DEPENDENCY_NEEDLE',
            path: 'apps/tui/node_modules/@opentui/solid',
        });

        expect(settlement.result.status).toBe('completed');
        expect(settlement.structuredOutput).toMatchObject({
            matches: [expect.objectContaining({ path: 'apps/tui/node_modules/@opentui/solid/index.ts' })],
        });
    });

    it('rejects a malformed invocation (missing pattern) before invoking rg', async () => {
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'src'), { recursive: true });
        const registry = await buildRegistry(workspaceRoot);
        const advertisement = registry.advertise().find((tool) => tool.name === 'ripgrep');
        if (advertisement === undefined) {
            throw new TypeError('ripgrep not registered');
        }

        const settlement = await registry.invoke({
            toolCallId: 'rg_malformed',
            toolName: 'ripgrep',
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify({ path: 'src' }),
        });

        expect(settlement.result.status).toBe('failed');
        expect(settlement.result.error?.code).toBe('schema_invalid');
    });

    it('respects head_limit by truncating content matches', async () => {
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'src'), { recursive: true });
        const lines: string[] = [];
        for (let index = 0; index < 50; index += 1) {
            lines.push(`needle-line-${index}`);
        }
        await writeFile(join(workspaceRoot, 'src', 'big.ts'), lines.join('\n') + '\n', 'utf8');
        const registry = await buildRegistry(workspaceRoot);

        const settlement = await invokeRipgrep(registry, {
            pattern: 'needle-line',
            output_mode: 'content',
            head_limit: 5,
        });

        expect(settlement.result.status).toBe('completed');
        const output = settlement.structuredOutput as {
            matches: ReadonlyArray<{ path: string; line: number; text: string }>;
            truncated: boolean;
        };
        expect(output.matches).toHaveLength(5);
        expect(output.truncated).toBe(true);
    });

    it('returns count-mode summaries per file', async () => {
        const workspaceRoot = await createWorkspace();
        await mkdir(join(workspaceRoot, 'src'), { recursive: true });
        await writeFile(join(workspaceRoot, 'src', 'a.ts'), 'needle\nneedle\nneedle\n', 'utf8');
        await writeFile(join(workspaceRoot, 'src', 'b.ts'), 'needle\n', 'utf8');
        const registry = await buildRegistry(workspaceRoot);

        const settlement = await invokeRipgrep(registry, {
            pattern: 'needle',
            output_mode: 'count',
        });

        expect(settlement.result.status).toBe('completed');
        const output = settlement.structuredOutput as {
            matches: ReadonlyArray<{ path: string; line: number }>;
        };
        const byPath = new Map(output.matches.map((match) => [match.path, match.line]));
        expect(byPath.get('src/a.ts')).toBe(3);
        expect(byPath.get('src/b.ts')).toBe(1);
    });

    it('advertises with capabilityClasses=[read]', async () => {
        const workspaceRoot = await createWorkspace();
        const registry = await buildRegistry(workspaceRoot);
        const advertisement = registry.advertise().find((tool) => tool.name === 'ripgrep');
        if (advertisement === undefined) {
            throw new TypeError('ripgrep not registered');
        }
        expect(advertisement.capabilityClasses).toEqual(['read']);
    });

    async function createWorkspace(): Promise<string> {
        const workspace = await mkdtemp(join(tmpdir(), 'mctrl-rg-factory-'));
        workspaces.push(workspace);
        return workspace;
    }

    async function buildRegistry(workspaceRoot: string): Promise<ToolRegistry> {
        const registry = new ToolRegistry();
        await registerRipgrepTool(registry, { workspaceRoot });
        return registry;
    }

    async function invokeRipgrep(
        registry: ToolRegistry,
        input: {
            readonly pattern: string;
            readonly path?: string;
            readonly include?: string;
            readonly output_mode?: 'content' | 'files_with_matches' | 'count';
            readonly head_limit?: number;
        },
    ) {
        const advertisement = registry.advertise().find((tool) => tool.name === 'ripgrep');
        if (advertisement === undefined) {
            throw new TypeError('ripgrep not registered');
        }
        const settlement = await registry.invoke({
            toolCallId: 'rg_factory_call',
            toolName: 'ripgrep',
            advertisedVersion: advertisement.version,
            argumentsJson: JSON.stringify(input),
        });
        return {
            result: settlement.result,
            structuredOutput: settlement.structuredOutput,
        };
    }
});

describe('workspace-scoped ripgrep registration (no rg required)', () => {
    it('registers under the name "ripgrep"', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-rg-name-'));
        try {
            const registry = new ToolRegistry();
            await registerRipgrepTool(registry, { workspaceRoot });
            const advertisement = registry.advertise().find((tool) => tool.name === 'ripgrep');
            expect(advertisement).toBeDefined();
            expect(advertisement?.capabilityClasses).toEqual(['read']);
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('rejects the static registration execute path with a guard error', async () => {
        const { ripgrepToolRegistration } = await import('./ripgrep-tool');
        await expect(
            ripgrepToolRegistration.execute(
                {} as never,
                {
                    toolCallId: 'rg_static_call',
                    toolName: 'ripgrep',
                } as never,
            ),
        ).rejects.toThrow(/workspace guard/);
    });

    it('skips tests when addon is not built but rg path is unusable', () => {
        // Sanity: the helper that probes rg in the test environment returns a boolean.
        expect(typeof rgAvailable).toBe('boolean');
    });
});
