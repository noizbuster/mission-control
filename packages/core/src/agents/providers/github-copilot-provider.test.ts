import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoadContext } from '../capability/types.js';
import { githubCopilotProvider } from './github-copilot-provider.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workspaceRoot: string;
let ctx: LoadContext;

beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-copilot-'));
    ctx = { workspaceRoot, userConfigDir: join(workspaceRoot, 'cfg') };
});

afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
});

async function writeAgent(relativePath: string, content: string): Promise<void> {
    const fullPath = join(workspaceRoot, relativePath);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, content);
}

describe('githubCopilotProvider', () => {
    it('(a) parses a valid .md agent from .github/copilot/agents/', async () => {
        await writeAgent(
            '.github/copilot/agents/reviewer.md',
            '---\nname: reviewer\ndescription: A code review agent.\ntools:\n  - read\n  - search\n---\nYou review code.',
        );

        const agents = await githubCopilotProvider.loadAgents(ctx);

        expect(agents).toHaveLength(1);
        expect(agents[0]?.name).toBe('reviewer');
        expect(agents[0]?.description).toBe('A code review agent.');
        expect(agents[0]?.source).toBe('project');
        expect(agents[0]?.tools).toEqual(['read', 'search']);
        expect(agents[0]?.filePath).toBe(join(workspaceRoot, '.github', 'copilot', 'agents', 'reviewer.md'));
    });

    it('(b) returns an empty array when .github/copilot/agents/ does not exist', async () => {
        const agents = await githubCopilotProvider.loadAgents(ctx);
        expect(agents).toEqual([]);
    });

    it('excludes AGENTS.md from the scan', async () => {
        await writeAgent(
            '.github/copilot/agents/AGENTS.md',
            '---\nname: should-not-load\ndescription: excluded.\n---\nbody',
        );
        await writeAgent('.github/copilot/agents/real.md', '---\nname: real\ndescription: A real agent.\n---\nbody');

        const agents = await githubCopilotProvider.loadAgents(ctx);

        expect(agents).toHaveLength(1);
        expect(agents[0]?.name).toBe('real');
    });

    it('(d) skips broken .md files without throwing', async () => {
        await writeAgent('.github/copilot/agents/broken.md', 'no frontmatter at all');
        await writeAgent('.github/copilot/agents/valid.md', '---\nname: valid\ndescription: A valid agent.\n---\nbody');

        const agents = await githubCopilotProvider.loadAgents(ctx);

        expect(agents).toHaveLength(1);
        expect(agents[0]?.name).toBe('valid');
    });

    it('has correct provider metadata', () => {
        expect(githubCopilotProvider.id).toBe('github-copilot');
        expect(githubCopilotProvider.priority).toBe(50);
        expect(githubCopilotProvider.displayName).toBe('GitHub Copilot');
    });

    it('loads multiple agents from the same directory', async () => {
        await writeAgent('.github/copilot/agents/x.md', '---\nname: x\ndescription: Agent X.\n---\nbody-x');
        await writeAgent('.github/copilot/agents/y.md', '---\nname: y\ndescription: Agent Y.\n---\nbody-y');

        const agents = await githubCopilotProvider.loadAgents(ctx);

        expect(agents.map((a) => a.name).sort()).toEqual(['x', 'y']);
    });
});
