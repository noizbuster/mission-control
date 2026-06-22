import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoadContext } from '../capability/types.js';
import { vscodeProvider } from './vscode-provider.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workspaceRoot: string;
let ctx: LoadContext;

beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-vscode-'));
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

describe('vscodeProvider', () => {
    it('(a) parses a valid .md agent from .vscode/agents/', async () => {
        await writeAgent(
            '.vscode/agents/coder.md',
            '---\nname: coder\ndescription: A coding agent.\ntools: read, edit, bash\n---\nYou write code.',
        );

        const agents = await vscodeProvider.loadAgents(ctx);

        expect(agents).toHaveLength(1);
        expect(agents[0]?.name).toBe('coder');
        expect(agents[0]?.description).toBe('A coding agent.');
        expect(agents[0]?.source).toBe('project');
        expect(agents[0]?.tools).toEqual(['read', 'edit', 'bash']);
        expect(agents[0]?.filePath).toBe(join(workspaceRoot, '.vscode', 'agents', 'coder.md'));
    });

    it('(b) returns an empty array when .vscode/agents/ does not exist', async () => {
        const agents = await vscodeProvider.loadAgents(ctx);
        expect(agents).toEqual([]);
    });

    it('excludes AGENTS.md from the scan', async () => {
        await writeAgent('.vscode/agents/AGENTS.md', '---\nname: should-not-load\ndescription: excluded.\n---\nbody');
        await writeAgent('.vscode/agents/real.md', '---\nname: real\ndescription: A real agent.\n---\nbody');

        const agents = await vscodeProvider.loadAgents(ctx);

        expect(agents).toHaveLength(1);
        expect(agents[0]?.name).toBe('real');
    });

    it('(d) skips broken .md files without throwing', async () => {
        await writeAgent('.vscode/agents/broken.md', 'no frontmatter here');
        await writeAgent('.vscode/agents/valid.md', '---\nname: valid\ndescription: A valid agent.\n---\nbody');

        const agents = await vscodeProvider.loadAgents(ctx);

        expect(agents).toHaveLength(1);
        expect(agents[0]?.name).toBe('valid');
    });

    it('has correct provider metadata', () => {
        expect(vscodeProvider.id).toBe('vscode');
        expect(vscodeProvider.priority).toBe(50);
        expect(vscodeProvider.displayName).toBe('VS Code');
    });

    it('loads multiple agents from the same directory', async () => {
        await writeAgent('.vscode/agents/a.md', '---\nname: a\ndescription: Agent A.\n---\nbody-a');
        await writeAgent('.vscode/agents/b.md', '---\nname: b\ndescription: Agent B.\n---\nbody-b');

        const agents = await vscodeProvider.loadAgents(ctx);

        expect(agents.map((a) => a.name).sort()).toEqual(['a', 'b']);
    });

    it('skips non-markdown files', async () => {
        await writeAgent('.vscode/agents/notes.txt', '---\nname: txt\ndescription: should skip.\n---\nbody');
        await writeAgent('.vscode/agents/real.md', '---\nname: real\ndescription: real.\n---\nbody');

        const agents = await vscodeProvider.loadAgents(ctx);

        expect(agents).toHaveLength(1);
        expect(agents[0]?.name).toBe('real');
    });
});
