import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ripgrepTestHooks } from './ripgrep-tool-factory';
import { resolveSearchCli } from './ripgrep-cli';
import { registerRipgrepTool } from './ripgrep-tool-factory';
import { ToolRegistry } from './tool-registry';

const grepAvailable = (() => {
    try {
        const result = spawnSync('grep', ['--version'], { encoding: 'utf8', shell: false });
        return result.status === 0;
    } catch {
        return false;
    }
})();

describe('ripgrep backend fallback chain', () => {
    afterEach(() => {
        ripgrepTestHooks.resetCliCache();
    });

    it('resolveSearchCli: prefers rg when available, then grep, then node', () => {
        ripgrepTestHooks.resetCliCache();
        const first = resolveSearchCli();
        // Whatever it resolves to, it must be one of the three backends.
        expect(['rg', 'grep', 'node']).toContain(first.backend);

        if (first.backend === 'rg') {
            expect(first.path).toBeTruthy();
            expect(first.path).not.toBe('node');
        } else if (first.backend === 'grep') {
            expect(first.path).toBeTruthy();
        } else {
            expect(first.backend).toBe('node');
        }
    });

    it('forceBackend("node"): skips rg + grep so pure-JS path runs', async () => {
        ripgrepTestHooks.forceBackend('node');
        const resolved = resolveSearchCli();
        expect(resolved.backend).toBe('node');

        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-rg-fallback-node-'));
        try {
            await mkdir(join(workspaceRoot, 'src'), { recursive: true });
            await writeFile(join(workspaceRoot, 'src', 'a.ts'), 'alpha\nneedle\nbeta\n', 'utf8');
            await writeFile(join(workspaceRoot, 'src', 'b.ts'), 'gamma\n', 'utf8');

            const registry = new ToolRegistry();
            await registerRipgrepTool(registry, { workspaceRoot });
            const ad = registry.advertise().find((t) => t.name === 'ripgrep');
            if (ad === undefined) throw new Error('ripgrep not registered');

            const settlement = await registry.invoke({
                toolCallId: 'fallback_node_files',
                toolName: 'ripgrep',
                advertisedVersion: ad.version,
                argumentsJson: JSON.stringify({ pattern: 'needle', output_mode: 'files_with_matches' }),
            });

            expect(settlement.result.status).toBe('completed');
            const output = settlement.structuredOutput as {
                matches: ReadonlyArray<{ path: string; line: number; text: string }>;
            };
            const paths = output.matches.map((m) => m.path);
            expect(paths).toContain('src/a.ts');
            expect(paths).not.toContain('src/b.ts');
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('pure-JS content mode returns the same shape as rg content mode (line numbers + text)', async () => {
        ripgrepTestHooks.forceBackend('node');

        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-rg-fallback-shape-'));
        try {
            await mkdir(join(workspaceRoot, 'src'), { recursive: true });
            await writeFile(
                join(workspaceRoot, 'src', 'a.ts'),
                'line one\nneedle here\nline three\nneedle again\n',
                'utf8',
            );

            const registry = new ToolRegistry();
            await registerRipgrepTool(registry, { workspaceRoot });
            const ad = registry.advertise().find((t) => t.name === 'ripgrep');
            if (ad === undefined) throw new Error('ripgrep not registered');

            const settlement = await registry.invoke({
                toolCallId: 'fallback_node_content',
                toolName: 'ripgrep',
                advertisedVersion: ad.version,
                argumentsJson: JSON.stringify({ pattern: 'needle', output_mode: 'content' }),
            });

            expect(settlement.result.status).toBe('completed');
            const output = settlement.structuredOutput as {
                matches: ReadonlyArray<{ path: string; line: number; text: string }>;
            };
            const lines = output.matches.map((m) => `${m.path}:${m.line}:${m.text}`);
            expect(lines).toContain('src/a.ts:2:needle here');
            expect(lines).toContain('src/a.ts:4:needle again');
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('pure-JS count mode returns per-file match counts', async () => {
        ripgrepTestHooks.forceBackend('node');

        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-rg-fallback-count-'));
        try {
            await mkdir(join(workspaceRoot, 'src'), { recursive: true });
            await writeFile(join(workspaceRoot, 'src', 'a.ts'), 'needle\nneedle\nneedle\n', 'utf8');
            await writeFile(join(workspaceRoot, 'src', 'b.ts'), 'needle\n', 'utf8');

            const registry = new ToolRegistry();
            await registerRipgrepTool(registry, { workspaceRoot });
            const ad = registry.advertise().find((t) => t.name === 'ripgrep');
            if (ad === undefined) throw new Error('ripgrep not registered');

            const settlement = await registry.invoke({
                toolCallId: 'fallback_node_count',
                toolName: 'ripgrep',
                advertisedVersion: ad.version,
                argumentsJson: JSON.stringify({ pattern: 'needle', output_mode: 'count' }),
            });

            expect(settlement.result.status).toBe('completed');
            const output = settlement.structuredOutput as {
                matches: ReadonlyArray<{ path: string; line: number }>;
            };
            const byPath = new Map(output.matches.map((m) => [m.path, m.line]));
            expect(byPath.get('src/a.ts')).toBe(3);
            expect(byPath.get('src/b.ts')).toBe(1);
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('pure-JS mode rejects invalid regex patterns', async () => {
        ripgrepTestHooks.forceBackend('node');

        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-rg-fallback-badregex-'));
        try {
            await mkdir(join(workspaceRoot, 'src'), { recursive: true });
            await writeFile(join(workspaceRoot, 'src', 'a.ts'), 'alpha\n', 'utf8');

            const registry = new ToolRegistry();
            await registerRipgrepTool(registry, { workspaceRoot });
            const ad = registry.advertise().find((t) => t.name === 'ripgrep');
            if (ad === undefined) throw new Error('ripgrep not registered');

            const settlement = await registry.invoke({
                toolCallId: 'fallback_badregex',
                toolName: 'ripgrep',
                advertisedVersion: ad.version,
                argumentsJson: JSON.stringify({ pattern: '[unclosed' }),
            });

            expect(settlement.result.status).toBe('failed');
            expect(settlement.result.error?.code).toBe('tool_failed');
            expect(settlement.result.error?.message).toMatch(/search_failed|invalid regex/);
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('pure-JS mode respects include glob filter', async () => {
        ripgrepTestHooks.forceBackend('node');

        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-rg-fallback-include-'));
        try {
            await mkdir(join(workspaceRoot, 'src'), { recursive: true });
            await writeFile(join(workspaceRoot, 'src', 'a.ts'), 'needle\n', 'utf8');
            await writeFile(join(workspaceRoot, 'src', 'b.json'), 'needle\n', 'utf8');

            const registry = new ToolRegistry();
            await registerRipgrepTool(registry, { workspaceRoot });
            const ad = registry.advertise().find((t) => t.name === 'ripgrep');
            if (ad === undefined) throw new Error('ripgrep not registered');

            const settlement = await registry.invoke({
                toolCallId: 'fallback_include',
                toolName: 'ripgrep',
                advertisedVersion: ad.version,
                argumentsJson: JSON.stringify({ pattern: 'needle', include: '*.ts' }),
            });

            expect(settlement.result.status).toBe('completed');
            const output = settlement.structuredOutput as {
                matches: ReadonlyArray<{ path: string }>;
            };
            const paths = output.matches.map((m) => m.path);
            expect(paths).toContain('src/a.ts');
            expect(paths).not.toContain('src/b.json');
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('pure-JS mode skips binary files silently', async () => {
        ripgrepTestHooks.forceBackend('node');

        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-rg-fallback-binary-'));
        try {
            await mkdir(join(workspaceRoot, 'src'), { recursive: true });
            await writeFile(join(workspaceRoot, 'src', 'binary.bin'), Buffer.from([0, 1, 2, 3, 0, 4, 5]));
            await writeFile(join(workspaceRoot, 'src', 'text.txt'), 'needle here\n', 'utf8');

            const registry = new ToolRegistry();
            await registerRipgrepTool(registry, { workspaceRoot });
            const ad = registry.advertise().find((t) => t.name === 'ripgrep');
            if (ad === undefined) throw new Error('ripgrep not registered');

            const settlement = await registry.invoke({
                toolCallId: 'fallback_binary',
                toolName: 'ripgrep',
                advertisedVersion: ad.version,
                argumentsJson: JSON.stringify({ pattern: 'needle' }),
            });

            expect(settlement.result.status).toBe('completed');
            const output = settlement.structuredOutput as {
                matches: ReadonlyArray<{ path: string }>;
            };
            const paths = output.matches.map((m) => m.path);
            expect(paths).toContain('src/text.txt');
            expect(paths).not.toContain('src/binary.bin');
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });
});

const describeWithGrep = grepAvailable ? describe : describe.skip;

describeWithGrep('ripgrep grep backend (forces grep by skipping rg)', () => {
    afterEach(() => {
        ripgrepTestHooks.resetCliCache();
    });

    it('returns files_with_matches via grep when rg tier is skipped', async () => {
        ripgrepTestHooks.forceBackend('grep');
        const resolved = resolveSearchCli();
        expect(resolved.backend).toBe('grep');

        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-rg-grep-files-'));
        try {
            await mkdir(join(workspaceRoot, 'src'), { recursive: true });
            await writeFile(join(workspaceRoot, 'src', 'a.ts'), 'needle\n', 'utf8');
            await writeFile(join(workspaceRoot, 'src', 'b.ts'), 'nothing\n', 'utf8');

            const registry = new ToolRegistry();
            await registerRipgrepTool(registry, { workspaceRoot });
            const ad = registry.advertise().find((t) => t.name === 'ripgrep');
            if (ad === undefined) throw new Error('ripgrep not registered');

            const settlement = await registry.invoke({
                toolCallId: 'grep_files',
                toolName: 'ripgrep',
                advertisedVersion: ad.version,
                argumentsJson: JSON.stringify({ pattern: 'needle', output_mode: 'files_with_matches' }),
            });

            expect(settlement.result.status).toBe('completed');
            const output = settlement.structuredOutput as {
                matches: ReadonlyArray<{ path: string }>;
            };
            const paths = output.matches.map((m) => m.path);
            expect(paths).toContain('src/a.ts');
            expect(paths).not.toContain('src/b.ts');
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('returns content matches with line numbers via grep', async () => {
        ripgrepTestHooks.forceBackend('grep');

        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-rg-grep-content-'));
        try {
            await mkdir(join(workspaceRoot, 'src'), { recursive: true });
            await writeFile(
                join(workspaceRoot, 'src', 'a.ts'),
                'line one\nneedle here\nline three\n',
                'utf8',
            );

            const registry = new ToolRegistry();
            await registerRipgrepTool(registry, { workspaceRoot });
            const ad = registry.advertise().find((t) => t.name === 'ripgrep');
            if (ad === undefined) throw new Error('ripgrep not registered');

            const settlement = await registry.invoke({
                toolCallId: 'grep_content',
                toolName: 'ripgrep',
                advertisedVersion: ad.version,
                argumentsJson: JSON.stringify({ pattern: 'needle', output_mode: 'content' }),
            });

            expect(settlement.result.status).toBe('completed');
            const output = settlement.structuredOutput as {
                matches: ReadonlyArray<{ path: string; line: number; text: string }>;
            };
            const found = output.matches.map((m) => `${m.path}:${m.line}:${m.text}`);
            expect(found).toContain('src/a.ts:2:needle here');
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('returns count summaries via grep -c', async () => {
        ripgrepTestHooks.forceBackend('grep');

        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-rg-grep-count-'));
        try {
            await mkdir(join(workspaceRoot, 'src'), { recursive: true });
            await writeFile(join(workspaceRoot, 'src', 'a.ts'), 'needle\nneedle\n', 'utf8');
            await writeFile(join(workspaceRoot, 'src', 'b.ts'), 'needle\n', 'utf8');

            const registry = new ToolRegistry();
            await registerRipgrepTool(registry, { workspaceRoot });
            const ad = registry.advertise().find((t) => t.name === 'ripgrep');
            if (ad === undefined) throw new Error('ripgrep not registered');

            const settlement = await registry.invoke({
                toolCallId: 'grep_count',
                toolName: 'ripgrep',
                advertisedVersion: ad.version,
                argumentsJson: JSON.stringify({ pattern: 'needle', output_mode: 'count' }),
            });

            expect(settlement.result.status).toBe('completed');
            const output = settlement.structuredOutput as {
                matches: ReadonlyArray<{ path: string; line: number }>;
            };
            const byPath = new Map(output.matches.map((m) => [m.path, m.line]));
            expect(byPath.get('src/a.ts')).toBe(2);
            expect(byPath.get('src/b.ts')).toBe(1);
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('respects include glob via grep --include', async () => {
        ripgrepTestHooks.forceBackend('grep');

        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-rg-grep-include-'));
        try {
            await mkdir(join(workspaceRoot, 'src'), { recursive: true });
            await writeFile(join(workspaceRoot, 'src', 'a.ts'), 'needle\n', 'utf8');
            await writeFile(join(workspaceRoot, 'src', 'b.json'), 'needle\n', 'utf8');

            const registry = new ToolRegistry();
            await registerRipgrepTool(registry, { workspaceRoot });
            const ad = registry.advertise().find((t) => t.name === 'ripgrep');
            if (ad === undefined) throw new Error('ripgrep not registered');

            const settlement = await registry.invoke({
                toolCallId: 'grep_include',
                toolName: 'ripgrep',
                advertisedVersion: ad.version,
                argumentsJson: JSON.stringify({ pattern: 'needle', include: '*.ts' }),
            });

            expect(settlement.result.status).toBe('completed');
            const output = settlement.structuredOutput as {
                matches: ReadonlyArray<{ path: string }>;
            };
            const paths = output.matches.map((m) => m.path);
            expect(paths).toContain('src/a.ts');
            expect(paths).not.toContain('src/b.json');
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });
});
