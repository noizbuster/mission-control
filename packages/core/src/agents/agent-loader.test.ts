import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MAX_AGENT_FILE_BYTES, discoverAgents } from './agent-loader.js';
import { BUNDLED_AGENT_TEMPLATES } from './bundled/index.js';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type TempArea = { readonly root: string; readonly workspace: string; readonly userConfig: string };

async function makeTempArea(): Promise<TempArea> {
    const root = await mkdtemp(join(tmpdir(), 'agents-test-'));
    const workspace = join(root, 'workspace');
    const userConfig = join(root, 'user-config');
    await mkdir(workspace, { recursive: true });
    await mkdir(userConfig, { recursive: true });
    return { root, workspace, userConfig };
}

async function writeAgent(baseDir: string, relativePath: string, content: string): Promise<string> {
    const filePath = join(baseDir, relativePath);
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, content, 'utf8');
    return filePath;
}

function validAgentMd(name: string, description?: string, body?: string): string {
    const desc = description ?? `Agent ${name}.`;
    const prompt = body ?? `You are the ${name} agent.`;
    return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${prompt}\n`;
}

describe('discoverAgents', () => {
    let area: TempArea;

    beforeEach(async () => {
        area = await makeTempArea();
    });

    afterEach(async () => {
        await rm(area.root, { recursive: true, force: true });
    });

    it('(a) project scope overrides bundled agent with the same name', async () => {
        await writeAgent(
            area.workspace,
            '.mctrl/agents/quick.md',
            validAgentMd('quick', 'Project override of bundled quick.'),
        );

        const result = await discoverAgents({
            workspaceRoot: area.workspace,
            userConfigDir: area.userConfig,
        });

        const quick = result.agents.find((a) => a.name === 'quick');
        expect(quick).toBeDefined();
        expect(quick?.source).toBe('project');
        expect(quick?.description).toBe('Project override of bundled quick.');
        const dupQuick = result.diagnostics.find((d) => d.code === 'duplicate_name' && d.agentName === 'quick');
        expect(dupQuick).toBeDefined();
    });

    it('(b) user scope overrides bundled agent with the same name', async () => {
        await writeAgent(
            area.userConfig,
            'agents/oracle.md',
            validAgentMd('oracle', 'User override of bundled oracle.'),
        );

        const result = await discoverAgents({
            workspaceRoot: area.workspace,
            userConfigDir: area.userConfig,
        });

        const oracle = result.agents.find((a) => a.name === 'oracle');
        expect(oracle).toBeDefined();
        expect(oracle?.source).toBe('user');
        expect(oracle?.description).toBe('User override of bundled oracle.');
        const dup = result.diagnostics.find((d) => d.code === 'duplicate_name' && d.agentName === 'oracle');
        expect(dup).toBeDefined();
    });

    it('(c) broken YAML frontmatter produces parse_error diagnostic, other files still load', async () => {
        await writeAgent(area.workspace, '.mctrl/agents/good.md', validAgentMd('good-agent'));
        await writeAgent(area.workspace, '.mctrl/agents/broken.md', '---\nname: "unterminated\n---\n\nbody\n');

        const result = await discoverAgents({
            workspaceRoot: area.workspace,
            userConfigDir: area.userConfig,
            includeBundled: false,
        });

        expect(result.agents.map((a) => a.name)).toContain('good-agent');
        const parseErrors = result.diagnostics.filter((d) => d.code === 'parse_error');
        expect(parseErrors.length).toBe(1);
        expect(parseErrors[0]?.agentName).toBe('broken');
    });

    it('(d) symlinked .md file is skipped with symlink_skipped diagnostic', async () => {
        const target = join(area.root, 'target.md');
        await writeFile(target, validAgentMd('symlinked'), 'utf8');
        const linkPath = join(area.workspace, '.mctrl', 'agents', 'link.md');
        await mkdir(join(linkPath, '..'), { recursive: true });
        await symlink(target, linkPath, 'file');

        const result = await discoverAgents({
            workspaceRoot: area.workspace,
            userConfigDir: area.userConfig,
            includeBundled: false,
        });

        expect(result.agents.find((a) => a.name === 'symlinked')).toBeUndefined();
        const symlinkDiag = result.diagnostics.find((d) => d.code === 'symlink_skipped');
        expect(symlinkDiag).toBeDefined();
        expect(symlinkDiag?.path).toBe(linkPath);
    });

    it('(e) file exceeding size bound is skipped with size_exceeded diagnostic', async () => {
        const padding = 'x'.repeat(DEFAULT_MAX_AGENT_FILE_BYTES + 100);
        await writeAgent(
            area.workspace,
            '.mctrl/agents/big.md',
            `---\nname: big\ndescription: Too big.\n---\n\n${padding}\n`,
        );

        const result = await discoverAgents({
            workspaceRoot: area.workspace,
            userConfigDir: area.userConfig,
            includeBundled: false,
        });

        expect(result.agents.find((a) => a.name === 'big')).toBeUndefined();
        expect(result.diagnostics.some((d) => d.code === 'size_exceeded')).toBe(true);
    });

    it('(f) file in denied directory (node_modules) is not discovered', async () => {
        await writeAgent(area.workspace, '.mctrl/agents/ok.md', validAgentMd('ok-agent'));
        await writeAgent(area.workspace, '.mctrl/agents/node_modules/hidden.md', validAgentMd('hidden-agent'));

        const result = await discoverAgents({
            workspaceRoot: area.workspace,
            userConfigDir: area.userConfig,
            includeBundled: false,
        });

        expect(result.agents.map((a) => a.name)).toEqual(['ok-agent']);
        expect(result.agents.find((a) => a.name === 'hidden-agent')).toBeUndefined();
    });

    it('(g) name collision within same scope: first-seen wins with duplicate_name diagnostic', async () => {
        await writeAgent(area.workspace, '.mctrl/agents/a-file.md', validAgentMd('shared', 'First definition.'));
        await writeAgent(area.workspace, '.mctrl/agents/b-file.md', validAgentMd('shared', 'Second definition.'));

        const result = await discoverAgents({
            workspaceRoot: area.workspace,
            userConfigDir: area.userConfig,
            includeBundled: false,
        });

        const sharedAgents = result.agents.filter((a) => a.name === 'shared');
        expect(sharedAgents.length).toBe(1);
        expect(sharedAgents[0]?.description).toBe('First definition.');
        const dup = result.diagnostics.find((d) => d.code === 'duplicate_name' && d.agentName === 'shared');
        expect(dup).toBeDefined();
    });

    it('(h) all 4 scopes merged with priority: project > user > plugin > bundled', async () => {
        const pluginDir = join(area.root, 'plugin-agents');
        await mkdir(pluginDir, { recursive: true });

        await writeAgent(area.workspace, '.mctrl/agents/proj-only.md', validAgentMd('proj-only'));
        await writeAgent(area.userConfig, 'agents/user-only.md', validAgentMd('user-only'));
        await writeAgent(pluginDir, 'plugin-only.md', validAgentMd('plugin-only'));

        const result = await discoverAgents({
            workspaceRoot: area.workspace,
            userConfigDir: area.userConfig,
            additionalDirs: [pluginDir],
        });

        const names = new Set(result.agents.map((a) => a.name));
        expect(names.has('proj-only')).toBe(true);
        expect(names.has('user-only')).toBe(true);
        expect(names.has('plugin-only')).toBe(true);
        expect(result.agents.length).toBe(3 + BUNDLED_AGENT_TEMPLATES.length);

        const projAgent = result.agents.find((a) => a.name === 'proj-only');
        expect(projAgent?.source).toBe('project');
        const userAgent = result.agents.find((a) => a.name === 'user-only');
        expect(userAgent?.source).toBe('user');
        const pluginAgent = result.agents.find((a) => a.name === 'plugin-only');
        expect(pluginAgent?.source).toBe('plugin');
        const bundledAgent = result.agents.find((a) => a.name === 'quick');
        expect(bundledAgent?.source).toBe('bundled');
    });

    it('(h2) project scope overrides user scope on name collision', async () => {
        await writeAgent(area.workspace, '.mctrl/agents/shared.md', validAgentMd('shared', 'From project scope.'));
        await writeAgent(area.userConfig, 'agents/shared.md', validAgentMd('shared', 'From user scope.'));

        const result = await discoverAgents({
            workspaceRoot: area.workspace,
            userConfigDir: area.userConfig,
            includeBundled: false,
        });

        const shared = result.agents.find((a) => a.name === 'shared');
        expect(shared?.source).toBe('project');
        expect(shared?.description).toBe('From project scope.');
    });

    it('(i) empty workspace with includeBundled=false yields no agents and no diagnostics', async () => {
        const result = await discoverAgents({
            workspaceRoot: area.workspace,
            userConfigDir: area.userConfig,
            includeBundled: false,
        });

        expect(result.agents).toEqual([]);
        expect(result.diagnostics).toEqual([]);
    });

    it('(j) max agents limit produces limit_reached diagnostics for extras', async () => {
        await writeAgent(area.workspace, '.mctrl/agents/a.md', validAgentMd('agent-a'));
        await writeAgent(area.workspace, '.mctrl/agents/b.md', validAgentMd('agent-b'));
        await writeAgent(area.workspace, '.mctrl/agents/c.md', validAgentMd('agent-c'));

        const result = await discoverAgents({
            workspaceRoot: area.workspace,
            userConfigDir: area.userConfig,
            includeBundled: false,
            maxAgents: 2,
        });

        expect(result.agents.length).toBe(2);
        const limited = result.diagnostics.filter((d) => d.code === 'limit_reached');
        expect(limited.length).toBe(1);
        expect(limited[0]?.agentName).toBe('agent-c');
    });

    it('(k) does not throw when scope directories are missing', async () => {
        const result = await discoverAgents({
            workspaceRoot: area.workspace,
            userConfigDir: area.userConfig,
            includeBundled: false,
        });
        expect(result.agents).toEqual([]);
        expect(result.diagnostics).toEqual([]);
    });

    it('(l) only .md files are loaded; other extensions ignored', async () => {
        await writeAgent(area.workspace, '.mctrl/agents/real.md', validAgentMd('real'));
        await writeAgent(area.workspace, '.mctrl/agents/readme.txt', 'not an agent');
        await writeAgent(area.workspace, '.mctrl/agents/data.json', '{"not": "an agent"}');

        const result = await discoverAgents({
            workspaceRoot: area.workspace,
            userConfigDir: area.userConfig,
            includeBundled: false,
        });

        expect(result.agents.map((a) => a.name)).toEqual(['real']);
    });

    it('(m) workspace root inside denylisted path skips project scope entirely', async () => {
        const deniedRoot = join(area.root, 'temp', 'ref-repos', 'proj');
        await mkdir(join(deniedRoot, '.mctrl', 'agents'), { recursive: true });
        await writeAgent(deniedRoot, '.mctrl/agents/leaked.md', validAgentMd('leaked'));

        const result = await discoverAgents({
            workspaceRoot: deniedRoot,
            userConfigDir: area.userConfig,
            includeBundled: false,
        });

        expect(result.agents.find((a) => a.name === 'leaked')).toBeUndefined();
    });
});
