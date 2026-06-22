import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoadContext } from '../capability/types.js';
import { CLAUDE_TOOL_NAME_MAP, convertClaudeFrontmatter, loadClaudeCompatibleAgents } from './_claude-compatible.js';
import { claudeCodeAgentProvider } from './claude-provider.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type TempArea = { readonly root: string; readonly workspace: string; readonly userConfig: string };

async function makeTemparea(): Promise<TempArea> {
    const root = await mkdtemp(join(tmpdir(), 'claude-provider-test-'));
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

describe('CLAUDE_TOOL_NAME_MAP', () => {
    it('maps known Claude Code tool names to mission-control tool IDs', () => {
        const expected: Record<string, string> = {
            Read: 'read',
            Grep: 'grep',
            Glob: 'glob',
            Bash: 'command.run',
            WebFetch: 'webfetch',
            Task: 'task',
            Skill: 'skill',
        };
        for (const [claudeName, mcName] of Object.entries(expected)) {
            expect(CLAUDE_TOOL_NAME_MAP[claudeName]).toBe(mcName);
        }
    });
});

describe('convertClaudeFrontmatter', () => {
    it('(a) maps tools CSV through CLAUDE_TOOL_NAME_MAP', () => {
        const result = convertClaudeFrontmatter(
            { name: 'triage', description: 'd', tools: 'Read, Grep, Glob' },
            '/dir',
        );
        expect(result.agent.tools).toEqual(['read', 'grep', 'glob']);
    });

    it('maps tools array through CLAUDE_TOOL_NAME_MAP', () => {
        const result = convertClaudeFrontmatter(
            { name: 't', description: 'd', tools: ['Read', 'Edit', 'Bash'] },
            '/dir',
        );
        expect(result.agent.tools).toEqual(['read', 'file.edit', 'command.run']);
    });

    it('passes through unknown tool names unchanged', () => {
        const result = convertClaudeFrontmatter({ name: 't', description: 'd', tools: ['Read', 'CustomTool'] }, '/dir');
        expect(result.agent.tools).toEqual(['read', 'CustomTool']);
    });

    it('(b) maps effort to thinkingLevel', () => {
        const result = convertClaudeFrontmatter({ name: 't', description: 'd', effort: 'high' }, '/dir');
        expect(result.agent.thinkingLevel).toBe('high');
    });

    it('accepts all valid effort levels', () => {
        for (const level of ['low', 'medium', 'high', 'xhigh']) {
            const result = convertClaudeFrontmatter({ name: 't', description: 'd', effort: level }, '/dir');
            expect(result.agent.thinkingLevel).toBe(level);
        }
    });

    it('records invalid effort as unsupported', () => {
        const result = convertClaudeFrontmatter({ name: 't', description: 'd', effort: 'turbo' }, '/dir');
        expect(result.agent.thinkingLevel).toBeUndefined();
        expect(result.unsupportedFields).toContain('effort');
    });

    it('maps skills array to autoloadSkills', () => {
        const result = convertClaudeFrontmatter({ name: 't', description: 'd', skills: ['coding', 'review'] }, '/dir');
        expect(result.agent.autoloadSkills).toEqual(['coding', 'review']);
    });

    it('passes through model, maxTurns, and color', () => {
        const result = convertClaudeFrontmatter(
            { name: 't', description: 'd', model: 'sonnet', maxTurns: 10, color: 'blue' },
            '/dir',
        );
        expect(result.agent.model).toBe('sonnet');
        expect(result.agent.maxTurns).toBe(10);
        expect(result.agent.color).toBe('blue');
    });

    it('collects disallowedTools as unsupported', () => {
        const result = convertClaudeFrontmatter({ name: 't', description: 'd', disallowedTools: 'Bash' }, '/dir');
        expect(result.unsupportedFields).toContain('disallowedTools');
        expect(result.agent.tools).toBeUndefined();
    });

    it('collects all unsupported fields', () => {
        const result = convertClaudeFrontmatter(
            {
                name: 't',
                description: 'd',
                hooks: [{ command: 'echo hi' }],
                permissionMode: 'acceptEdits',
                mcpServers: { foo: { command: 'bar' } },
                initialPrompt: 'hello',
                memory: true,
                background: false,
                isolation: true,
            },
            '/dir',
        );
        expect(result.unsupportedFields).toEqual(
            expect.arrayContaining([
                'hooks',
                'permissionMode',
                'mcpServers',
                'initialPrompt',
                'memory',
                'background',
                'isolation',
            ]),
        );
    });
});

describe('claudeCodeAgentProvider', () => {
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
        expect(claudeCodeAgentProvider.id).toBe('claude-code');
        expect(claudeCodeAgentProvider.displayName).toBe('Claude Code');
        expect(claudeCodeAgentProvider.priority).toBe(50);
    });

    it('(a) parses a valid Claude agent and maps tools', async () => {
        await writeFileDeep(
            join(area.workspace, '.claude', 'agents', 'triage.md'),
            [
                '---',
                'name: triage',
                'description: Triage incoming issues',
                'tools: "Read, Grep, Glob"',
                'effort: high',
                '---',
                'You triage issues.',
            ].join('\n'),
        );

        const agents = await claudeCodeAgentProvider.loadAgents(ctx);

        expect(agents).toHaveLength(1);
        const agent = agents[0];
        expect(agent).toBeDefined();
        expect(agent?.name).toBe('triage');
        expect(agent?.description).toBe('Triage incoming issues');
        expect(agent?.tools).toEqual(['read', 'grep', 'glob']);
        expect(agent?.thinkingLevel).toBe('high');
        expect(agent?.systemPrompt).toBe('You triage issues.');
        expect(agent?.source).toBe('plugin');
    });

    it('(b) maps effort to thinkingLevel from a user-scope file', async () => {
        await writeFileDeep(
            join(area.userConfig, 'claude', 'agents', 'deep-thinker.md'),
            [
                '---',
                'name: deep-thinker',
                'description: Deep analysis agent',
                'effort: xhigh',
                'model: opus',
                '---',
                'Think deeply about the problem.',
            ].join('\n'),
        );

        const agents = await claudeCodeAgentProvider.loadAgents(ctx);

        expect(agents).toHaveLength(1);
        expect(agents[0]?.thinkingLevel).toBe('xhigh');
        expect(agents[0]?.model).toBe('opus');
        expect(agents[0]?.source).toBe('plugin');
    });

    it('loads agents from both project and user scopes', async () => {
        await writeFileDeep(
            join(area.workspace, '.claude', 'agents', 'project-agent.md'),
            ['---', 'name: project-agent', 'description: Project scoped', '---', 'Project prompt.'].join('\n'),
        );
        await writeFileDeep(
            join(area.userConfig, 'claude', 'agents', 'user-agent.md'),
            ['---', 'name: user-agent', 'description: User scoped', '---', 'User prompt.'].join('\n'),
        );

        const agents = await claudeCodeAgentProvider.loadAgents(ctx);

        expect(agents.map((a) => a.name).sort()).toEqual(['project-agent', 'user-agent']);
    });

    it('(d) returns empty array with no errors for an empty .claude/agents/ dir', async () => {
        await mkdir(join(area.workspace, '.claude', 'agents'), { recursive: true });

        const agents = await claudeCodeAgentProvider.loadAgents(ctx);

        expect(agents).toEqual([]);
    });

    it('(e) returns empty array when .claude/ dir does not exist', async () => {
        const agents = await claudeCodeAgentProvider.loadAgents(ctx);

        expect(agents).toEqual([]);
    });

    it('does not parse agents.md as an agent', async () => {
        await writeFileDeep(
            join(area.workspace, '.claude', 'agents', 'AGENTS.md'),
            '---\nname: should-not-load\ndescription: x\n---\nbody\n',
        );
        await writeFileDeep(
            join(area.workspace, '.claude', 'agents', 'real.md'),
            '---\nname: real\ndescription: Real agent\n---\nReal prompt.\n',
        );

        const agents = await claudeCodeAgentProvider.loadAgents(ctx);

        expect(agents.map((a) => a.name)).toEqual(['real']);
    });

    it('skips broken files while loading valid siblings', async () => {
        await writeFileDeep(
            join(area.workspace, '.claude', 'agents', 'good.md'),
            '---\nname: good\ndescription: Good\n---\nGood prompt.\n',
        );
        await writeFileDeep(join(area.workspace, '.claude', 'agents', 'broken.md'), 'no frontmatter here');

        const agents = await claudeCodeAgentProvider.loadAgents(ctx);

        expect(agents.map((a) => a.name)).toEqual(['good']);
    });
});

describe('loadClaudeCompatibleAgents (diagnostics)', () => {
    let area: TempArea;
    let ctx: LoadContext;

    beforeEach(async () => {
        area = await makeTemparea();
        ctx = { workspaceRoot: area.workspace, userConfigDir: area.userConfig };
    });

    afterEach(async () => {
        await rm(area.root, { recursive: true, force: true });
    });

    it('(c) emits unsupported_field diagnostic and still loads the agent', async () => {
        await writeFileDeep(
            join(area.workspace, '.claude', 'agents', 'hooked.md'),
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

        const result = await loadClaudeCompatibleAgents(
            ctx,
            [join(area.workspace, '.claude', 'agents')],
            'claude-code',
        );

        expect(result.agents).toHaveLength(1);
        expect(result.agents[0]?.name).toBe('hooked');

        const unsupported = result.diagnostics.filter((d) => d.code === 'unsupported_field');
        expect(unsupported.length).toBeGreaterThanOrEqual(2);
        const messages = unsupported.map((d) => d.message);
        expect(messages.some((m) => m.includes('hooks'))).toBe(true);
        expect(messages.some((m) => m.includes('permissionMode'))).toBe(true);
        expect(unsupported.every((d) => d.severity === 'info')).toBe(true);
    });

    it('produces no diagnostics for a clean Claude agent', async () => {
        await writeFileDeep(
            join(area.workspace, '.claude', 'agents', 'clean.md'),
            [
                '---',
                'name: clean',
                'description: No unsupported fields',
                'tools: "Read, Grep"',
                'effort: medium',
                '---',
                'Clean agent.',
            ].join('\n'),
        );

        const result = await loadClaudeCompatibleAgents(
            ctx,
            [join(area.workspace, '.claude', 'agents')],
            'claude-code',
        );

        expect(result.agents).toHaveLength(1);
        expect(result.diagnostics).toHaveLength(0);
    });

    it('produces a parse_error diagnostic for a broken file', async () => {
        await writeFileDeep(join(area.workspace, '.claude', 'agents', 'broken.md'), 'no frontmatter at all');

        const result = await loadClaudeCompatibleAgents(
            ctx,
            [join(area.workspace, '.claude', 'agents')],
            'claude-code',
        );

        expect(result.agents).toHaveLength(0);
        const errors = result.diagnostics.filter((d) => d.code === 'parse_error');
        expect(errors).toHaveLength(1);
        expect(errors[0]?.severity).toBe('error');
    });
});
