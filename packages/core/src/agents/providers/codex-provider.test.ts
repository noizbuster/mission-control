import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexAgentProvider } from './codex-provider.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type TempArea = { readonly root: string; readonly workspace: string; readonly userConfig: string };

async function makeTempArea(): Promise<TempArea> {
    const root = await mkdtemp(join(tmpdir(), 'codex-provider-test-'));
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

describe('codexAgentProvider', () => {
    let area: TempArea;

    beforeEach(async () => {
        area = await makeTempArea();
    });

    afterEach(async () => {
        await rm(area.root, { recursive: true, force: true });
    });

    it('(a) parses a valid agent .md file from the project .codex/agents directory', async () => {
        const filePath = await writeAgent(
            area.workspace,
            '.codex/agents/researcher.md',
            validAgentMd('codex-researcher', 'A Codex researcher agent.'),
        );

        const agents = await codexAgentProvider.loadAgents({
            workspaceRoot: area.workspace,
            userConfigDir: area.userConfig,
        });

        expect(agents).toHaveLength(1);
        expect(agents[0]?.name).toBe('codex-researcher');
        expect(agents[0]?.description).toBe('A Codex researcher agent.');
        expect(agents[0]?.source).toBe('project');
        expect(agents[0]?.filePath).toBe(filePath);
        expect(agents[0]?.systemPrompt).toBe('You are the codex-researcher agent.');
    });

    it('(b) does NOT load AGENTS.md as an agent declaration (context file, per A7)', async () => {
        await writeAgent(
            area.workspace,
            '.codex/agents/AGENTS.md',
            '---\nname: agents\ndescription: Should be excluded.\n---\n\nThis is a context file, not an agent.',
        );
        await writeAgent(area.workspace, '.codex/agents/real-agent.md', validAgentMd('real-codex-agent'));

        const agents = await codexAgentProvider.loadAgents({
            workspaceRoot: area.workspace,
            userConfigDir: area.userConfig,
        });

        const names = agents.map((a) => a.name);
        expect(names).not.toContain('agents');
        expect(names).toEqual(['real-codex-agent']);
    });

    it('(c) returns an empty array and does not throw when scan directories are missing', async () => {
        const agents = await codexAgentProvider.loadAgents({
            workspaceRoot: area.workspace,
            userConfigDir: area.userConfig,
        });

        expect(agents).toEqual([]);
    });

    it('(d) skips a broken .md file and still loads valid siblings', async () => {
        await writeAgent(area.workspace, '.codex/agents/good.md', validAgentMd('good-codex'));
        await writeAgent(area.workspace, '.codex/agents/broken.md', 'this file has no YAML frontmatter at all');

        const agents = await codexAgentProvider.loadAgents({
            workspaceRoot: area.workspace,
            userConfigDir: area.userConfig,
        });

        const names = agents.map((a) => a.name);
        expect(names).toEqual(['good-codex']);
        expect(names).not.toContain('broken');
    });
});
