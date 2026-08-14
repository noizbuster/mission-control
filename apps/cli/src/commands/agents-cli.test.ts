// allow: SIZE_OK -- HEAD 511 -> current 511 pure LOC; agents CLI list/unpack contract coverage including bundled count.
import { type AgentDefinition, AgentIndex, discoverAgents } from '@mission-control/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatAgentsCliList, parseAgentsSubcommand, runAgentsCliCommand } from './agents-cli';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type TempArea = { readonly root: string; readonly workspace: string; readonly userConfig: string };

async function makeTempArea(): Promise<TempArea> {
    const root = await mkdtemp(join(tmpdir(), 'agents-cli-test-'));
    const workspace = join(root, 'workspace');
    const userConfig = join(root, 'user-config');
    await mkdir(workspace, { recursive: true });
    await mkdir(userConfig, { recursive: true });
    return { root, workspace, userConfig };
}

async function discoverAll(area: TempArea): Promise<readonly AgentDefinition[]> {
    const result = await discoverAgents({
        workspaceRoot: area.workspace,
        userConfigDir: area.userConfig,
    });
    return result.agents;
}

describe('parseAgentsSubcommand', () => {
    it('parses empty args as list', () => {
        expect(parseAgentsSubcommand([])).toEqual({ kind: 'list' });
    });

    it('parses list and ls as list', () => {
        expect(parseAgentsSubcommand(['list'])).toEqual({ kind: 'list' });
        expect(parseAgentsSubcommand(['ls'])).toEqual({ kind: 'list' });
    });

    it('rejects list with extra args', () => {
        const cmd = parseAgentsSubcommand(['list', 'extra']);
        expect(cmd.kind).toBe('invalid');
    });

    it('parses show <name>', () => {
        expect(parseAgentsSubcommand(['show', 'oracle'])).toEqual({ kind: 'show', name: 'oracle' });
    });

    it('rejects show without a name', () => {
        const cmd = parseAgentsSubcommand(['show']);
        expect(cmd.kind).toBe('invalid');
    });

    it('rejects show with extra args', () => {
        const cmd = parseAgentsSubcommand(['show', 'oracle', 'extra']);
        expect(cmd.kind).toBe('invalid');
    });

    it('parses unpack <name>', () => {
        expect(parseAgentsSubcommand(['unpack', 'oracle'])).toEqual({ kind: 'unpack', name: 'oracle' });
    });

    it('rejects unpack without a name', () => {
        const cmd = parseAgentsSubcommand(['unpack']);
        expect(cmd.kind).toBe('invalid');
    });

    it('(regression) unpack <name> returns no flags key for backward-compat', () => {
        // Given/When: parsing a bare single-name unpack
        const cmd = parseAgentsSubcommand(['unpack', 'oracle']);
        // Then: the command deep-equals { kind:'unpack', name:'oracle' } with NO flags key.
        // Fails if the parser accidentally always-attaches flags.
        expect(cmd).toEqual({ kind: 'unpack', name: 'oracle' });
        expect(cmd).not.toHaveProperty('flags');
    });

    it('parses unpack --all into a flags-only command', () => {
        expect(parseAgentsSubcommand(['unpack', '--all'])).toEqual({ kind: 'unpack', flags: { all: true } });
    });

    it('parses unpack --all with multiple boolean flags', () => {
        expect(parseAgentsSubcommand(['unpack', '--all', '--force', '--json'])).toEqual({
            kind: 'unpack',
            flags: { all: true, force: true, json: true },
        });
    });

    it('parses unpack --all --user and --all --project', () => {
        expect(parseAgentsSubcommand(['unpack', '--all', '--user'])).toEqual({
            kind: 'unpack',
            flags: { all: true, user: true },
        });
        expect(parseAgentsSubcommand(['unpack', '--all', '--project'])).toEqual({
            kind: 'unpack',
            flags: { all: true, project: true },
        });
    });

    it('parses unpack --all --dir <path> (space-separated)', () => {
        expect(parseAgentsSubcommand(['unpack', '--all', '--dir', './tmp/x'])).toEqual({
            kind: 'unpack',
            flags: { all: true, dir: './tmp/x' },
        });
    });

    it('parses unpack --all --dir=<path> (equals-separated)', () => {
        expect(parseAgentsSubcommand(['unpack', '--all', '--dir=./tmp/x'])).toEqual({
            kind: 'unpack',
            flags: { all: true, dir: './tmp/x' },
        });
    });

    it('parses unpack <name> --force as name + flags', () => {
        expect(parseAgentsSubcommand(['unpack', 'oracle', '--force'])).toEqual({
            kind: 'unpack',
            name: 'oracle',
            flags: { force: true },
        });
    });

    it('rejects unpack --all with a positional name', () => {
        expect(parseAgentsSubcommand(['unpack', '--all', 'oracle']).kind).toBe('invalid');
    });

    it('rejects unpack --user and --project together', () => {
        expect(parseAgentsSubcommand(['unpack', '--all', '--user', '--project']).kind).toBe('invalid');
    });

    it('rejects unpack --dir with --user/--project', () => {
        expect(parseAgentsSubcommand(['unpack', '--all', '--dir', './x', '--user']).kind).toBe('invalid');
        expect(parseAgentsSubcommand(['unpack', '--all', '--dir', './x', '--project']).kind).toBe('invalid');
    });

    it('rejects unpack --dir with no value at end of args', () => {
        expect(parseAgentsSubcommand(['unpack', '--all', '--dir']).kind).toBe('invalid');
    });

    it('rejects unpack --dir= (empty value)', () => {
        expect(parseAgentsSubcommand(['unpack', '--all', '--dir=']).kind).toBe('invalid');
    });

    it('rejects unpack with an unknown flag', () => {
        expect(parseAgentsSubcommand(['unpack', '--all', '--bogus']).kind).toBe('invalid');
    });

    it('parses disable <name> and enable <name>', () => {
        expect(parseAgentsSubcommand(['disable', 'oracle'])).toEqual({ kind: 'disable', name: 'oracle' });
        expect(parseAgentsSubcommand(['enable', 'oracle'])).toEqual({ kind: 'enable', name: 'oracle' });
    });

    it('rejects disable without a name', () => {
        const cmd = parseAgentsSubcommand(['disable']);
        expect(cmd.kind).toBe('invalid');
    });

    it('parses import <harness> <path>', () => {
        expect(parseAgentsSubcommand(['import', 'claude', '/path/to/agent.md'])).toEqual({
            kind: 'import',
            harness: 'claude',
            path: '/path/to/agent.md',
        });
    });

    it('rejects import without enough args', () => {
        expect(parseAgentsSubcommand(['import']).kind).toBe('invalid');
        expect(parseAgentsSubcommand(['import', 'claude']).kind).toBe('invalid');
    });

    it('rejects unknown subcommand', () => {
        const cmd = parseAgentsSubcommand(['frobnicate', 'oracle']);
        expect(cmd.kind).toBe('invalid');
    });
});

describe('runAgentsCliCommand list', () => {
    let area: TempArea;

    beforeEach(async () => {
        area = await makeTempArea();
    });

    afterEach(async () => {
        await rm(area.root, { recursive: true, force: true });
    });

    it('(a) lists 12 bundled agents as 12 rows', async () => {
        // Given: a fresh workspace with only bundled agents
        // When: running the list command
        // Then: output contains exactly 12 agent rows (one per bundled agent)
        const output = await runAgentsCliCommand(
            { kind: 'list' },
            {
                workspaceRoot: area.workspace,
                userConfigDir: area.userConfig,
            },
        );

        const agents = await discoverAll(area);
        expect(agents.length).toBe(12);
        for (const agent of agents) {
            expect(output).toContain(agent.name);
        }
        expect(output).toContain('Discovered agents (12)');
    });

    it('includes disabled marker for agents in the disabled config', async () => {
        // Given: oracle is disabled
        const disabledPath = join(area.workspace, '.mctrl', 'agents.disabled');
        await mkdir(join(disabledPath, '..'), { recursive: true });
        await writeFile(disabledPath, JSON.stringify({ disabled: ['oracle'], version: 1 }), 'utf8');

        // When
        const output = await runAgentsCliCommand(
            { kind: 'list' },
            {
                workspaceRoot: area.workspace,
                userConfigDir: area.userConfig,
            },
        );

        // Then: oracle row contains a disabled marker
        const oracleLine = output.split('\n').find((l) => l.includes('oracle'));
        expect(oracleLine).toBeDefined();
        expect(oracleLine ?? '').toContain('disabled');
    });
});

describe('runAgentsCliCommand show', () => {
    let area: TempArea;

    beforeEach(async () => {
        area = await makeTempArea();
    });

    afterEach(async () => {
        await rm(area.root, { recursive: true, force: true });
    });

    it('(d) shows detailed info for an existing agent', async () => {
        // Given: bundled agents are available
        // When: showing the oracle agent
        // Then: output contains name, description, source, model, tier
        const output = await runAgentsCliCommand(
            { kind: 'show', name: 'oracle' },
            {
                workspaceRoot: area.workspace,
                userConfigDir: area.userConfig,
            },
        );

        expect(output).toContain('Agent: oracle');
        expect(output).toContain('Source: bundled');
        expect(output).toContain('Model: mctrl/slow');
        expect(output).toContain('Tier: read');
    });

    it('throws for a nonexistent agent', async () => {
        await expect(
            runAgentsCliCommand(
                { kind: 'show', name: 'does-not-exist' },
                {
                    workspaceRoot: area.workspace,
                    userConfigDir: area.userConfig,
                },
            ),
        ).rejects.toThrow(/not found/);
    });
});

describe('runAgentsCliCommand unpack', () => {
    let area: TempArea;

    beforeEach(async () => {
        area = await makeTempArea();
    });

    afterEach(async () => {
        await rm(area.root, { recursive: true, force: true });
    });

    it('(b) copies bundled oracle to .mctrl/agents/oracle.md', async () => {
        // Given: a fresh workspace
        // When: unpacking the bundled oracle agent
        // Then: file exists at .mctrl/agents/oracle.md with valid frontmatter
        const output = await runAgentsCliCommand(
            { kind: 'unpack', name: 'oracle' },
            {
                workspaceRoot: area.workspace,
                userConfigDir: area.userConfig,
            },
        );

        const targetPath = join(area.workspace, '.mctrl', 'agents', 'oracle.md');
        const stats = await stat(targetPath);
        expect(stats.isFile()).toBe(true);

        const contents = await readFile(targetPath, 'utf8');
        expect(contents).toContain('name: oracle');
        expect(contents).toContain('tier: read');

        // Output should mention the target path
        expect(output).toContain(targetPath);
    });

    it('throws for a nonexistent bundled agent', async () => {
        await expect(
            runAgentsCliCommand(
                { kind: 'unpack', name: 'not-a-bundled-agent' },
                {
                    workspaceRoot: area.workspace,
                    userConfigDir: area.userConfig,
                },
            ),
        ).rejects.toThrow(/not found/);
    });

    it('(bulk) unpack --all writes all 12 bundled agents to project dir', async () => {
        // Given: a fresh workspace
        // When: running unpack --all
        // Then: exactly 12 .md files land under <workspace>/.mctrl/agents/
        const targetDir = join(area.workspace, '.mctrl', 'agents');
        const output = await runAgentsCliCommand(
            { kind: 'unpack', flags: { all: true } },
            { workspaceRoot: area.workspace, userConfigDir: area.userConfig },
        );

        const entries = await readdir(targetDir);
        const mdFiles = entries.filter((name) => name.endsWith('.md'));
        expect(mdFiles.length).toBe(12);
        expect(output).toContain('12 of 12');
    });

    it('(bulk) unpack --all skips existing files without --force', async () => {
        // Given: oracle.md already exists in the target dir
        const targetDir = join(area.workspace, '.mctrl', 'agents');
        await mkdir(targetDir, { recursive: true });
        await writeFile(join(targetDir, 'oracle.md'), 'stale content\n', 'utf8');

        // When: running unpack --all (no --force)
        const output = await runAgentsCliCommand(
            { kind: 'unpack', flags: { all: true } },
            { workspaceRoot: area.workspace, userConfigDir: area.userConfig },
        );

        // Then: oracle.md is skipped (stale content preserved), 8 written, no throw
        const stale = await readFile(join(targetDir, 'oracle.md'), 'utf8');
        expect(stale).toBe('stale content\n');
        expect(output).toContain('Skipped 1 existing');
        const mdFiles = (await readdir(targetDir)).filter((name) => name.endsWith('.md'));
        expect(mdFiles.length).toBe(12);
    });

    it('(bulk) unpack --all --force overwrites existing files', async () => {
        // Given: oracle.md already exists with stale content
        const targetDir = join(area.workspace, '.mctrl', 'agents');
        await mkdir(targetDir, { recursive: true });
        await writeFile(join(targetDir, 'oracle.md'), 'stale content\n', 'utf8');

        // When: running unpack --all --force
        await runAgentsCliCommand(
            { kind: 'unpack', flags: { all: true, force: true } },
            { workspaceRoot: area.workspace, userConfigDir: area.userConfig },
        );

        // Then: oracle.md is overwritten with the bundled content
        const contents = await readFile(join(targetDir, 'oracle.md'), 'utf8');
        expect(contents).toContain('name: oracle');
        expect(contents).not.toContain('stale content');
    });

    it('(bulk) unpack --all --user targets <userConfigDir>/agents', async () => {
        // Given: a fresh workspace + user config dir
        // When: running unpack --all --user
        // Then: all 9 files land under <userConfig>/agents, not under the project
        const userTargetDir = join(area.userConfig, 'agents');
        const output = await runAgentsCliCommand(
            { kind: 'unpack', flags: { all: true, user: true } },
            { workspaceRoot: area.workspace, userConfigDir: area.userConfig },
        );

        const mdFiles = (await readdir(userTargetDir)).filter((name) => name.endsWith('.md'));
        expect(mdFiles.length).toBe(12);
        expect(output).toContain(userTargetDir);
        // Project dir must NOT be created
        const projectDir = join(area.workspace, '.mctrl', 'agents');
        await expect(stat(projectDir)).rejects.toThrow();
    });

    it('(bulk) unpack --all --dir <relpath> resolves against workspace root', async () => {
        // Given: a fresh workspace
        // When: running unpack --all --dir ./tmp/x
        // Then: files land under <workspace>/tmp/x (resolved), 9 total
        const targetDir = join(area.workspace, 'tmp', 'x');
        await runAgentsCliCommand(
            { kind: 'unpack', flags: { all: true, dir: './tmp/x' } },
            { workspaceRoot: area.workspace, userConfigDir: area.userConfig },
        );

        const mdFiles = (await readdir(targetDir)).filter((name) => name.endsWith('.md'));
        expect(mdFiles.length).toBe(12);
    });

    it('(bulk) unpack --all --json returns UnpackResult JSON with total 12', async () => {
        // Given: a fresh workspace
        // When: running unpack --all --json
        // Then: stdout is JSON with total=12, written.length=12, skipped empty
        const raw = await runAgentsCliCommand(
            { kind: 'unpack', flags: { all: true, json: true } },
            { workspaceRoot: area.workspace, userConfigDir: area.userConfig },
        );

        const parsed = JSON.parse(raw) as { targetDir: string; total: number; written: string[]; skipped: string[] };
        expect(parsed.total).toBe(12);
        expect(parsed.written.length).toBe(12);
        expect(parsed.skipped.length).toBe(0);
        expect(parsed.targetDir).toContain('.mctrl');
    });

    it('(bulk) unpack --all --json surfaces skipped entries, not silent success', async () => {
        // Given: one file already exists
        const targetDir = join(area.workspace, '.mctrl', 'agents');
        await mkdir(targetDir, { recursive: true });
        await writeFile(join(targetDir, 'oracle.md'), 'stale\n', 'utf8');

        // When: running unpack --all --json (no force)
        const raw = await runAgentsCliCommand(
            { kind: 'unpack', flags: { all: true, json: true } },
            { workspaceRoot: area.workspace, userConfigDir: area.userConfig },
        );

        // Then: JSON reports 1 skipped so an all-skipped run is never a silent success
        const parsed = JSON.parse(raw) as { total: number; written: string[]; skipped: string[] };
        expect(parsed.total).toBe(12);
        expect(parsed.written.length).toBe(11);
        expect(parsed.skipped.length).toBe(1);
    });
});

describe('runAgentsCliCommand disable / enable', () => {
    let area: TempArea;

    beforeEach(async () => {
        area = await makeTempArea();
    });

    afterEach(async () => {
        await rm(area.root, { recursive: true, force: true });
    });

    it('(c) disable of unknown agent throws', async () => {
        // Given: the agent name does not match any discovered agent
        // When: disabling it
        // Then: an error is thrown mentioning the name was not found
        await expect(
            runAgentsCliCommand(
                { kind: 'disable', name: 'ghost' },
                {
                    workspaceRoot: area.workspace,
                    userConfigDir: area.userConfig,
                },
            ),
        ).rejects.toThrow(/not found/);
    });

    it('disable writes the agent name into .mctrl/agents.disabled', async () => {
        const disabledPath = join(area.workspace, '.mctrl', 'agents.disabled');
        const output = await runAgentsCliCommand(
            { kind: 'disable', name: 'oracle' },
            {
                workspaceRoot: area.workspace,
                userConfigDir: area.userConfig,
            },
        );

        const raw = await readFile(disabledPath, 'utf8');
        const parsed = JSON.parse(raw) as { disabled: string[] };
        expect(parsed.disabled).toContain('oracle');
        expect(output).toContain('oracle');
    });

    it('enable removes the agent name from .mctrl/agents.disabled', async () => {
        const disabledPath = join(area.workspace, '.mctrl', 'agents.disabled');
        await mkdir(join(disabledPath, '..'), { recursive: true });
        await writeFile(disabledPath, JSON.stringify({ disabled: ['oracle', 'explore'], version: 1 }), 'utf8');

        const output = await runAgentsCliCommand(
            { kind: 'enable', name: 'oracle' },
            {
                workspaceRoot: area.workspace,
                userConfigDir: area.userConfig,
            },
        );

        const raw = await readFile(disabledPath, 'utf8');
        const parsed = JSON.parse(raw) as { disabled: string[] };
        expect(parsed.disabled).not.toContain('oracle');
        expect(parsed.disabled).toContain('explore');
        expect(output).toContain('oracle');
    });

    it('enable is idempotent when the agent is not disabled', async () => {
        const output = await runAgentsCliCommand(
            { kind: 'enable', name: 'oracle' },
            {
                workspaceRoot: area.workspace,
                userConfigDir: area.userConfig,
            },
        );

        // Should succeed and mention the agent name
        expect(output).toContain('oracle');
        // A no-op enable must not create the config file — the agent is trivially enabled
        const disabledPath = join(area.workspace, '.mctrl', 'agents.disabled');
        await expect(stat(disabledPath)).rejects.toThrow();
    });
});

describe('runAgentsCliCommand import', () => {
    let area: TempArea;

    beforeEach(async () => {
        area = await makeTempArea();
    });

    afterEach(async () => {
        await rm(area.root, { recursive: true, force: true });
    });

    it('converts a harness agent file to .mctrl/agents/<name>.md', async () => {
        // Given: a source agent file in mctrl-native format
        const sourcePath = join(area.root, 'source-agent.md');
        const sourceContent =
            '---\nname: imported-agent\ndescription: An imported test agent.\nmodel: local/local-echo\ntier: read\n---\n\nYou are an imported test agent.\n';
        await writeFile(sourcePath, sourceContent, 'utf8');

        // When: importing it as a codex harness agent
        const output = await runAgentsCliCommand(
            { kind: 'import', harness: 'codex', path: sourcePath },
            {
                workspaceRoot: area.workspace,
                userConfigDir: area.userConfig,
            },
        );

        // Then: file exists at .mctrl/agents/imported-agent.md with valid content
        const targetPath = join(area.workspace, '.mctrl', 'agents', 'imported-agent.md');
        const stats = await stat(targetPath);
        expect(stats.isFile()).toBe(true);
        const contents = await readFile(targetPath, 'utf8');
        expect(contents).toContain('name: imported-agent');
        expect(output).toContain(targetPath);
    });

    it('rejects import of a nonexistent source file', async () => {
        await expect(
            runAgentsCliCommand(
                { kind: 'import', harness: 'codex', path: join(area.root, 'nope.md') },
                {
                    workspaceRoot: area.workspace,
                    userConfigDir: area.userConfig,
                },
            ),
        ).rejects.toThrow();
    });

    it('rejects import of an invalid agent file', async () => {
        const sourcePath = join(area.root, 'broken.md');
        await writeFile(sourcePath, 'this is not valid frontmatter at all', 'utf8');

        await expect(
            runAgentsCliCommand(
                { kind: 'import', harness: 'codex', path: sourcePath },
                {
                    workspaceRoot: area.workspace,
                    userConfigDir: area.userConfig,
                },
            ),
        ).rejects.toThrow();
    });
});

describe('formatAgentsCliList', () => {
    it('renders one row per agent plus a header', () => {
        const agents: AgentDefinition[] = [
            {
                name: 'explore',
                description: 'Explorer.',
                systemPrompt: '...',
                source: 'bundled',
                model: 'mctrl/smol',
                tier: 'read',
            },
            {
                name: 'oracle',
                description: 'Consultant.',
                systemPrompt: '...',
                source: 'bundled',
                model: 'mctrl/slow',
                tier: 'read',
            },
        ];
        const disabled = new Set<string>(['oracle']);

        const output = formatAgentsCliList(agents, disabled);

        expect(output).toContain('Discovered agents (2)');
        expect(output).toContain('explore');
        expect(output).toContain('oracle');
        // oracle is disabled, explore is not — only oracle's row should carry the disabled marker
        const oracleLine = output.split('\n').find((l) => l.includes('oracle'));
        const exploreLine = output.split('\n').find((l) => l.includes('explore'));
        expect(oracleLine ?? '').toContain('disabled');
        expect(exploreLine ?? '').not.toContain('disabled');
    });

    it('handles an empty agent list', () => {
        const output = formatAgentsCliList([], new Set());
        expect(output).toContain('No agents discovered');
    });
});

describe('runAgentsCliCommand invalid', () => {
    let area: TempArea;

    beforeEach(async () => {
        area = await makeTempArea();
    });

    afterEach(async () => {
        await rm(area.root, { recursive: true, force: true });
    });

    it('returns an error message for invalid commands', async () => {
        const output = await runAgentsCliCommand(
            { kind: 'invalid', message: 'bad input' },
            { workspaceRoot: area.workspace, userConfigDir: area.userConfig },
        );
        expect(output).toContain('bad input');
    });
});

// Guard: ensure the AgentIndex + discoverAgents integration surfaces all 9 bundled agents.
describe('bundled agent count', () => {
    let area: TempArea;

    beforeEach(async () => {
        area = await makeTempArea();
    });

    afterEach(async () => {
        await rm(area.root, { recursive: true, force: true });
    });

    it('discovers exactly 12 bundled agents through the registry', async () => {
        const result = await discoverAgents({
            workspaceRoot: area.workspace,
            userConfigDir: area.userConfig,
        });
        const index = new AgentIndex(result);
        expect(index.list().length).toBe(12);
    });
});
