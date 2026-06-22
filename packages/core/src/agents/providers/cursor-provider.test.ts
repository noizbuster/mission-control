import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoadContext } from '../capability/types.js';
import { loadClaudeCompatibleAgents } from './_claude-compatible.js';
import { cursorAgentProvider } from './cursor-provider.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type TempArea = { readonly root: string; readonly workspace: string; readonly userConfig: string };

async function makeTemparea(): Promise<TempArea> {
    const root = await mkdtemp(join(tmpdir(), 'cursor-provider-test-'));
    const workspace = join(root, 'workspace');
    const userConfig = join(root, 'user-config');
    await mkdir(workspace, { recursive: true });
    await mkdir(userConfig, { recursive: true });
    return { root, workspace, userConfig };
}

async function writeFileDeep(filePath: string, content: string): Promise<void> {
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, content, 'utf8');
}

describe('cursorAgentProvider', () => {
    let area: TempArea;
    let ctx: LoadContext;

    beforeEach(async () => {
        area = await makeTemparea();
        ctx = { workspaceRoot: area.workspace, userConfigDir: area.userConfig };
    });

    afterEach(async () => {
        await rm(area.root, { recursive: true, force: true });
    });

    it('has the expected provider metadata', () => {
        expect(cursorAgentProvider.id).toBe('cursor');
        expect(cursorAgentProvider.displayName).toBe('Cursor');
        expect(cursorAgentProvider.priority).toBe(50);
    });

    it('(a) parses a valid Cursor agent and maps tools', async () => {
        await writeFileDeep(
            join(area.workspace, '.cursor', 'agents', 'reviewer.md'),
            [
                '---',
                'name: reviewer',
                'description: Reviews pull requests',
                'tools: "Read, Grep, Glob"',
                'effort: high',
                '---',
                'You review pull requests.',
            ].join('\n'),
        );

        const agents = await cursorAgentProvider.loadAgents(ctx);

        expect(agents).toHaveLength(1);
        const agent = agents[0];
        expect(agent).toBeDefined();
        expect(agent?.name).toBe('reviewer');
        expect(agent?.description).toBe('Reviews pull requests');
        expect(agent?.tools).toEqual(['read', 'grep', 'glob']);
        expect(agent?.thinkingLevel).toBe('high');
        expect(agent?.systemPrompt).toBe('You review pull requests.');
        expect(agent?.source).toBe('plugin');
    });

    it('loads agents from both project and user scopes', async () => {
        await writeFileDeep(
            join(area.workspace, '.cursor', 'agents', 'project-agent.md'),
            ['---', 'name: project-agent', 'description: Project scoped', '---', 'Project prompt.'].join('\n'),
        );
        await writeFileDeep(
            join(area.userConfig, 'cursor', 'agents', 'user-agent.md'),
            ['---', 'name: user-agent', 'description: User scoped', '---', 'User prompt.'].join('\n'),
        );

        const agents = await cursorAgentProvider.loadAgents(ctx);

        expect(agents.map((a) => a.name).sort()).toEqual(['project-agent', 'user-agent']);
    });

    it('(b) returns empty array when .cursor/ dir does not exist', async () => {
        const agents = await cursorAgentProvider.loadAgents(ctx);

        expect(agents).toEqual([]);
    });

    it('returns empty array for an empty .cursor/agents/ dir', async () => {
        await mkdir(join(area.workspace, '.cursor', 'agents'), { recursive: true });

        const agents = await cursorAgentProvider.loadAgents(ctx);

        expect(agents).toEqual([]);
    });

    it('(c) skips broken files while loading valid siblings', async () => {
        await writeFileDeep(
            join(area.workspace, '.cursor', 'agents', 'good.md'),
            '---\nname: good\ndescription: Good\n---\nGood prompt.\n',
        );
        await writeFileDeep(join(area.workspace, '.cursor', 'agents', 'broken.md'), 'no frontmatter here');

        const agents = await cursorAgentProvider.loadAgents(ctx);

        expect(agents.map((a) => a.name)).toEqual(['good']);
    });

    it('does not parse agents.md as an agent', async () => {
        await writeFileDeep(
            join(area.workspace, '.cursor', 'agents', 'AGENTS.md'),
            '---\nname: should-not-load\ndescription: x\n---\nbody\n',
        );
        await writeFileDeep(
            join(area.workspace, '.cursor', 'agents', 'real.md'),
            '---\nname: real\ndescription: Real agent\n---\nReal prompt.\n',
        );

        const agents = await cursorAgentProvider.loadAgents(ctx);

        expect(agents.map((a) => a.name)).toEqual(['real']);
    });
});

describe('cursorAgentProvider (diagnostics via shared helper)', () => {
    let area: TempArea;
    let ctx: LoadContext;

    beforeEach(async () => {
        area = await makeTemparea();
        ctx = { workspaceRoot: area.workspace, userConfigDir: area.userConfig };
    });

    afterEach(async () => {
        await rm(area.root, { recursive: true, force: true });
    });

    it('emits unsupported_field diagnostics tagged with the cursor provider id', async () => {
        await writeFileDeep(
            join(area.workspace, '.cursor', 'agents', 'hooked.md'),
            [
                '---',
                'name: hooked',
                'description: Has unsupported fields',
                'hooks:',
                '  - command: echo hi',
                'permissionMode: acceptEdits',
                '---',
                'Agent with hooks.',
            ].join('\n'),
        );

        const result = await loadClaudeCompatibleAgents(ctx, [join(area.workspace, '.cursor', 'agents')], 'cursor');

        expect(result.agents).toHaveLength(1);
        expect(result.agents[0]?.name).toBe('hooked');

        const unsupported = result.diagnostics.filter((d) => d.code === 'unsupported_field');
        expect(unsupported.length).toBeGreaterThanOrEqual(2);
        for (const d of unsupported) {
            expect(d.message.startsWith('[cursor]')).toBe(true);
        }
    });

    it('produces a parse_error diagnostic tagged with the cursor provider id for a broken file', async () => {
        await writeFileDeep(join(area.workspace, '.cursor', 'agents', 'broken.md'), 'no frontmatter at all');

        const result = await loadClaudeCompatibleAgents(ctx, [join(area.workspace, '.cursor', 'agents')], 'cursor');

        expect(result.agents).toHaveLength(0);
        const errors = result.diagnostics.filter((d) => d.code === 'parse_error');
        expect(errors).toHaveLength(1);
        expect(errors[0]?.severity).toBe('error');
        expect(errors[0]?.message.startsWith('[cursor]')).toBe(true);
    });
});
