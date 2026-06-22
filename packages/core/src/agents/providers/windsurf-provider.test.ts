import type { AgentDefinition } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoadContext } from '../capability/types.js';
import { windsurfAgentProvider } from './windsurf-provider.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type TempArea = { readonly root: string; readonly workspace: string; readonly userConfig: string };

async function makeTempArea(): Promise<TempArea> {
    const root = await mkdtemp(join(tmpdir(), 'windsurf-provider-test-'));
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

function validAgentMd(name: string, description?: string, body?: string): string {
    const desc = description ?? `Agent ${name}.`;
    const prompt = body ?? `You are the ${name} agent.`;
    return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${prompt}\n`;
}

describe('windsurfAgentProvider', () => {
    let area: TempArea;
    let ctx: LoadContext;

    beforeEach(async () => {
        area = await makeTempArea();
        ctx = { workspaceRoot: area.workspace, userConfigDir: area.userConfig };
    });

    afterEach(async () => {
        await rm(area.root, { recursive: true, force: true });
    });

    it('(a) parses valid .md agents from project and user scopes', async () => {
        await writeFileDeep(
            join(area.workspace, '.windsurf', 'agents', 'refactor-bot.md'),
            validAgentMd('refactor-bot', 'Refactors code.'),
        );
        await writeFileDeep(
            join(area.userConfig, 'codeium', 'windsurf', 'agents', 'shared-helper.md'),
            validAgentMd('shared-helper', 'Shared helper agent.'),
        );

        const agents = await windsurfAgentProvider.loadAgents(ctx);

        expect(agents).toHaveLength(2);
        const project = agents.find((a) => a.name === 'refactor-bot');
        expect(project).toBeDefined();
        expect(project?.source).toBe('project');
        expect(project?.description).toBe('Refactors code.');
        expect(project?.systemPrompt).toContain('refactor-bot');
        expect(project?.filePath).toBe(join(area.workspace, '.windsurf', 'agents', 'refactor-bot.md'));

        const user = agents.find((a) => a.name === 'shared-helper');
        expect(user).toBeDefined();
        expect(user?.source).toBe('user');
        expect(user?.filePath).toBe(join(area.userConfig, 'codeium', 'windsurf', 'agents', 'shared-helper.md'));
    });

    it('(b) returns empty array when no .windsurf/agents directories exist', async () => {
        const agents = await windsurfAgentProvider.loadAgents(ctx);

        expect(agents).toEqual([]);
    });

    it('(c) skips broken .md files while loading valid ones from the same directory', async () => {
        await writeFileDeep(
            join(area.workspace, '.windsurf', 'agents', 'good.md'),
            validAgentMd('good-agent', 'A valid agent.'),
        );
        await writeFileDeep(
            join(area.workspace, '.windsurf', 'agents', 'broken.md'),
            '---\nname: "unterminated\n---\n\nbody\n',
        );

        const agents = await windsurfAgentProvider.loadAgents(ctx);

        const names = agents.map((a: AgentDefinition) => a.name);
        expect(names).toContain('good-agent');
        expect(names).not.toContain('broken');
        expect(agents).toHaveLength(1);
    });

    it('does not parse AGENTS.md as an agent', async () => {
        await writeFileDeep(
            join(area.workspace, '.windsurf', 'agents', 'AGENTS.md'),
            validAgentMd('should-not-load', 'Should not be parsed.'),
        );
        await writeFileDeep(
            join(area.workspace, '.windsurf', 'agents', 'real-agent.md'),
            validAgentMd('real-agent', 'A real agent.'),
        );

        const agents = await windsurfAgentProvider.loadAgents(ctx);

        const names = agents.map((a) => a.name);
        expect(names).toEqual(['real-agent']);
        expect(names).not.toContain('should-not-load');
    });

    it('ignores non-.md files', async () => {
        await writeFileDeep(join(area.workspace, '.windsurf', 'agents', 'agent.md'), validAgentMd('md-agent'));
        await writeFileDeep(join(area.workspace, '.windsurf', 'agents', 'readme.txt'), 'not an agent');
        await writeFileDeep(join(area.workspace, '.windsurf', 'agents', 'config.json'), '{"not": "an agent"}');

        const agents = await windsurfAgentProvider.loadAgents(ctx);

        expect(agents.map((a) => a.name)).toEqual(['md-agent']);
    });

    it('has the expected provider metadata', () => {
        expect(windsurfAgentProvider.id).toBe('windsurf');
        expect(windsurfAgentProvider.displayName).toBe('Windsurf');
        expect(windsurfAgentProvider.priority).toBe(50);
    });
});
