import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoadContext } from '../capability/types.js';
import { opencodeProvider } from './opencode-provider.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workspaceRoot: string;
let userConfigDir: string;
let ctx: LoadContext;

beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-oc-ws-'));
    userConfigDir = await mkdtemp(join(tmpdir(), 'mctrl-oc-cfg-'));
    ctx = { workspaceRoot, userConfigDir };
});

afterEach(async () => {
    await Promise.all([
        rm(workspaceRoot, { recursive: true, force: true }),
        rm(userConfigDir, { recursive: true, force: true }),
    ]);
});

async function writeFileIn(base: string, relativePath: string, content: string): Promise<void> {
    const fullPath = join(base, relativePath);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, content);
}

describe('opencodeProvider', () => {
    it('(a) parses a valid .md agent from .opencode/agent/', async () => {
        await writeFileIn(
            workspaceRoot,
            '.opencode/agent/build.md',
            '---\nname: build\ndescription: Default build agent.\nmodel: opencode/gpt-5.4\n---\nYou are a build agent.',
        );

        const agents = await opencodeProvider.loadAgents(ctx);

        expect(agents).toHaveLength(1);
        expect(agents[0]?.name).toBe('build');
        expect(agents[0]?.description).toBe('Default build agent.');
        expect(agents[0]?.source).toBe('project');
        expect(agents[0]?.model).toBe('opencode/gpt-5.4');
        expect(agents[0]?.filePath).toBe(join(workspaceRoot, '.opencode', 'agent', 'build.md'));
    });

    it('(b) returns an empty array when neither project nor user dir exists', async () => {
        const agents = await opencodeProvider.loadAgents(ctx);
        expect(agents).toEqual([]);
    });

    it('(c) converts object-map tools to enabled-only string array', async () => {
        await writeFileIn(
            workspaceRoot,
            '.opencode/agent/triage.md',
            [
                '---',
                'name: triage',
                'description: A triage agent.',
                'model: opencode/gpt-5.4-nano',
                'tools:',
                '  "*": false',
                '  "github-triage": true',
                '  search: true',
                '  "disabled-tool": false',
                '---',
                'You triage github issues.',
            ].join('\n'),
        );

        const agents = await opencodeProvider.loadAgents(ctx);

        expect(agents).toHaveLength(1);
        const tools = agents[0]?.tools;
        expect(tools).toBeDefined();
        expect([...(tools ?? [])].sort()).toEqual(['github-triage', 'search']);
    });

    it('(d) skips broken .md files without throwing', async () => {
        await writeFileIn(workspaceRoot, '.opencode/agent/broken.md', 'no frontmatter');
        await writeFileIn(
            workspaceRoot,
            '.opencode/agent/valid.md',
            '---\nname: valid\ndescription: A valid agent.\n---\nbody',
        );

        const agents = await opencodeProvider.loadAgents(ctx);

        expect(agents).toHaveLength(1);
        expect(agents[0]?.name).toBe('valid');
    });

    it('excludes AGENTS.md from the scan', async () => {
        await writeFileIn(
            workspaceRoot,
            '.opencode/agent/AGENTS.md',
            '---\nname: should-not-load\ndescription: excluded.\n---\nbody',
        );
        await writeFileIn(
            workspaceRoot,
            '.opencode/agent/real.md',
            '---\nname: real\ndescription: A real agent.\n---\nbody',
        );

        const agents = await opencodeProvider.loadAgents(ctx);

        expect(agents).toHaveLength(1);
        expect(agents[0]?.name).toBe('real');
    });

    it('loads agents from both project and user directories', async () => {
        await writeFileIn(
            workspaceRoot,
            '.opencode/agent/project-agent.md',
            '---\nname: proj\ndescription: Project agent.\n---\nbody-proj',
        );
        await writeFileIn(
            userConfigDir,
            'opencode/agent/user-agent.md',
            '---\nname: usr\ndescription: User agent.\n---\nbody-usr',
        );

        const agents = await opencodeProvider.loadAgents(ctx);

        expect(agents.map((a) => a.name).sort()).toEqual(['proj', 'usr']);
        const proj = agents.find((a) => a.name === 'proj');
        const usr = agents.find((a) => a.name === 'usr');
        expect(proj?.source).toBe('project');
        expect(usr?.source).toBe('user');
    });

    it('has correct provider metadata', () => {
        expect(opencodeProvider.id).toBe('opencode');
        expect(opencodeProvider.priority).toBe(50);
        expect(opencodeProvider.displayName).toBe('OpenCode');
    });

    it('uses singular "agent" directory name (not "agents")', async () => {
        // A file in .opencode/agents/ (plural) must NOT be discovered.
        await writeFileIn(
            workspaceRoot,
            '.opencode/agents/plural.md',
            '---\nname: plural\ndescription: Should not load from plural dir.\n---\nbody',
        );
        await writeFileIn(
            workspaceRoot,
            '.opencode/agent/singular.md',
            '---\nname: singular\ndescription: Should load from singular dir.\n---\nbody',
        );

        const agents = await opencodeProvider.loadAgents(ctx);

        expect(agents).toHaveLength(1);
        expect(agents[0]?.name).toBe('singular');
    });
});
