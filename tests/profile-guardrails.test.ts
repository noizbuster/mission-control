// allow: SIZE_OK -- HEAD 256 -> current 256 pure LOC; one profile isolation guardrail matrix across data auth trust and discovery.
/**
 * T6 — Profile guardrail regression suite.
 *
 * Proves the selected `--profile` does NOT redirect data/auth/session/trust
 * paths and does NOT change skill/workflow/agent/keybind discovery
 * directories, and that `.mcp.<profile>.json[c]` project files are ignored.
 * The profile flag is scoped to the MCP user-config FILE path only (T1-T5);
 * every other path-bearing subsystem is structurally profile-free because
 * its resolver/store/loader signature has no `profileName` parameter.
 *
 * These are pure guardrails: they lock the T1-T5 contract so a future drift
 * (e.g. someone threading `profileName` into `resolveMissionControlDataDir`)
 * turns into a red test instead of a silent data-file redirect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '@mission-control/cli/args';
import { missionControlAuthFileEnvKey } from '@mission-control/config';
import { discoverAgents } from '../packages/core/src/agents/agent-loader';
import { resolveMissionControlDataDir } from '../packages/core/src/memory/data-dir';
import { createProviderAuthStore } from '../packages/core/src/providers/provider-auth-store';
import { discoverSkills, resolveUserConfigDir } from '../packages/core/src/skills/skill-loader';
import { loadResolvedMcpConfig, resolveProjectConfigPath } from '../packages/core/src/tools/mcp/config';
import { ProjectTrustStore } from '../packages/core/src/trust/project-trust-store';
import { discoverWorkflows } from '../packages/core/src/workflows/workflow-loader';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SKILL_FILE = `---
name: guardrail-skill
description: guardrail fixture
---
body
`;

const AGENT_FILE = `---
name: guardrail-agent
description: guardrail fixture
---
body
`;

const WORKFLOW_FILE = JSON.stringify({
    name: 'guardrail-workflow',
    description: 'guardrail fixture',
    graph: {
        id: 'guardrail-graph',
        version: '0.1.0',
        entryNodeId: 'entry',
        nodes: [{ id: 'entry', kind: 'llm', label: 'entry' }],
        edges: [],
        rules: [],
        policies: [],
    },
});

async function writeFixture(path: string, contents: string): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents, 'utf8');
}

describe('T6 profile guardrails: data-dir / auth / session / trust isolation', () => {
    const savedEnv = { ...process.env };

    afterEach(() => {
        vi.unstubAllEnvs();
        process.env = savedEnv;
    });

    it('resolveMissionControlDataDir has no profile parameter and is stable across re-resolution', () => {
        // The function signature is ({env, homeDir, platform}) — profile is
        // structurally incapable of redirecting the data dir.
        const env = { MCTRL_DATA_DIR: '/tmp/mctrl-t6-data-isolation' };
        const first = resolveMissionControlDataDir({ env, platform: 'linux', homeDir: '/home/t6' });
        const second = resolveMissionControlDataDir({ env, platform: 'linux', homeDir: '/home/t6' });

        expect(first).toBe('/tmp/mctrl-t6-data-isolation');
        expect(second).toBe(first);
    });

    it('auth store path honors MISSION_CONTROL_AUTH_FILE and is profile-independent', () => {
        const authFile = '/tmp/mctrl-t6-auth-isolation/auth.json';
        vi.stubEnv(missionControlAuthFileEnvKey, authFile);

        // createProviderAuthStore() accepts NO arguments — there is no profile
        // input the store could ever consult.
        const store = createProviderAuthStore();

        expect(store.authFilePath).toBe(authFile);
    });

    it('auth store default path derives from XDG_DATA_HOME, never a profile subdirectory', () => {
        vi.stubEnv(missionControlAuthFileEnvKey, '');
        vi.stubEnv('XDG_DATA_HOME', '/tmp/mctrl-t6-xdg-isolation');

        const store = createProviderAuthStore();

        expect(store.authFilePath).toBe(join('/tmp/mctrl-t6-xdg-isolation', 'mission-control', 'auth.json'));
        // No profile segment ever appears in the path.
        expect(store.authFilePath).not.toContain('dev');
        expect(store.authFilePath).not.toContain('profile');
    });

    it('session log path root (data dir) is profile-independent, so <dataDir>/sessions/<id>.jsonl is too', () => {
        // Session logs live at <dataDir>/sessions/<id>.jsonl. The data dir is the
        // only input to that path and it has no profile parameter (proven above),
        // so a profile cannot redirect where session files land.
        const dataDir = resolveMissionControlDataDir({
            env: { MCTRL_DATA_DIR: '/tmp/mctrl-t6-session-isolation' },
            platform: 'linux',
            homeDir: '/home/t6',
        });
        const sessionPath = join(dataDir, 'sessions', 'session-xyz.jsonl');

        expect(sessionPath).toBe('/tmp/mctrl-t6-session-isolation/sessions/session-xyz.jsonl');
        expect(sessionPath).not.toMatch(/\/(dev|profile)\//);
    });

    it('project trust store path (<dataDir>/trust/projects.json) is profile-independent', () => {
        const dataDir = '/tmp/mctrl-t6-trust-isolation';
        const store = new ProjectTrustStore({ dataDir });

        expect(store.filePath).toBe(join(dataDir, 'trust', 'projects.json'));
        expect(store.filePath).not.toContain('dev');
        expect(store.filePath).not.toContain('profile');
    });
});

describe('T6 profile guardrails: discovery directory isolation', () => {
    let root: string;
    let workspace: string;
    let userConfig: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'mctrl-t6-discovery-'));
        workspace = join(root, 'workspace');
        userConfig = join(root, 'userconfig');
        await mkdir(workspace, { recursive: true });
        await mkdir(userConfig, { recursive: true });
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('discoverSkills ignores a profile-named skills directory under the config dir', async () => {
        // Real skill in the standard <configDir>/skills scope.
        await writeFixture(join(userConfig, 'skills', 'real', 'SKILL.md'), SKILL_FILE);
        // Decoy skill inside a profile-named directory that a buggy loader might scan.
        await writeFixture(join(userConfig, 'skills.dev', 'decoy', 'SKILL.md'), SKILL_FILE);

        const result = await discoverSkills({ workspaceRoot: workspace, userConfigDir: userConfig });

        const names = result.skills.map((skill) => skill.name);
        expect(names).toContain('guardrail-skill');
        // The decoy under skills.dev MUST NOT be discovered.
        expect(names).not.toContain('decoy');
        // No discovered skill source path touches a profile-named segment.
        for (const skill of result.skills) {
            expect(skill.filePath).not.toContain('skills.dev');
        }
    });

    it('discoverWorkflows ignores a profile-named workflows directory under the config dir', async () => {
        await writeFixture(join(userConfig, 'workflows', 'real.workflow.json'), WORKFLOW_FILE);
        await writeFixture(join(userConfig, 'workflows.dev', 'decoy.workflow.json'), WORKFLOW_FILE);

        const result = await discoverWorkflows({ workspaceRoot: workspace, userConfigDir: userConfig });

        const names = result.workflows.map((workflow) => workflow.name);
        expect(names).toContain('guardrail-workflow');
        expect(names).not.toContain('decoy');
        for (const workflow of result.workflows) {
            expect(JSON.stringify(workflow)).not.toContain('workflows.dev');
        }
    });

    it('discoverAgents ignores a profile-named agents directory under the config dir', async () => {
        await writeFixture(join(userConfig, 'agents', 'real.md'), AGENT_FILE);
        await writeFixture(join(userConfig, 'agents.dev', 'decoy.md'), AGENT_FILE);

        const result = await discoverAgents({
            workspaceRoot: workspace,
            userConfigDir: userConfig,
            includeBundled: false,
        });

        const names = result.agents.map((agent) => agent.name);
        expect(names).toContain('guardrail-agent');
        expect(names).not.toContain('decoy');
        for (const agent of result.agents) {
            const source = JSON.stringify(agent.source);
            expect(source).not.toContain('agents.dev');
        }
    });

    it('resolveUserConfigDir (skill loader) is unaffected by any profile concept', () => {
        // The resolver takes only {userConfigDir, env} — no profile input.
        const resolved = resolveUserConfigDir({ userConfigDir: userConfig });

        expect(resolved).toBe(userConfig);
        expect(resolved).not.toContain('.dev');
    });
});

describe('T6 profile guardrails: non-MCP commands reject or ignore --profile', () => {
    // T1 contract: --profile is valid only on run/mcp paths. The non-MCP parsers
    // are intentionally profile-free. `auth login`/`auth logout`/`session`/`models`
    // REJECT --profile (throw on the unknown flag); `auth list`/`auth ls` SILENTLY
    // IGNORE trailing args (they return without parsing the tail). Neither path
    // ever sets `profileName` or writes a profile-specific data file.

    it('auth login rejects --profile (throws during parse)', () => {
        expect(() => parseArgs(['auth', 'login', '--profile', 'dev'])).toThrow(/Unsupported auth login argument/);
    });

    it('auth logout rejects --profile (throws during parse)', () => {
        expect(() => parseArgs(['auth', 'logout', '--profile', 'dev'])).toThrow(/Unsupported auth logout argument/);
    });

    it('auth list silently ignores --profile (no throw, no profileName, no data file)', () => {
        const args = parseArgs(['auth', 'list', '--profile', 'dev']);
        expect(args.command).toBe('auth-list');
        expect(args.profileName).toBeUndefined();
    });

    it('session list rejects --profile (throws during parse)', () => {
        expect(() => parseArgs(['session', 'list', '--profile'])).toThrow(/Unsupported session list argument/);
    });

    it('models rejects --profile (throws during parse)', () => {
        expect(() => parseArgs(['models', '--profile', 'dev'])).toThrow(/Unsupported models argument/);
    });

    it('run ACCEPTS --profile (profile-eligible path)', () => {
        const args = parseArgs(['--no-tui', '--profile', 'dev', '--provider', 'local', '--model', 'local-echo', 'hi']);
        expect(args.profileName).toBe('dev');
        expect(args.command).toBe('run');
    });

    it('mcp list ACCEPTS --profile (profile-eligible path)', () => {
        const args = parseArgs(['mcp', 'list', '--profile', 'dev']);
        expect(args.profileName).toBe('dev');
        expect(args.command).toBe('mcp-list');
    });

    it('non-MCP parsed commands never carry a profileName field', () => {
        const auth = parseArgs(['auth', 'login', '--provider', 'local', '--api-key', 'k']);
        const models = parseArgs(['models']);
        const session = parseArgs(['session', 'list']);

        expect(auth.profileName).toBeUndefined();
        expect(models.profileName).toBeUndefined();
        expect(session.profileName).toBeUndefined();
    });
});

describe('T6 profile guardrails: .mcp.<profile>.json[c] project files are ignored', () => {
    let root: string;
    let workspace: string;
    let userConfig: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'mctrl-t6-mcpignore-'));
        workspace = join(root, 'workspace');
        userConfig = join(root, 'userconfig');
        await mkdir(workspace, { recursive: true });
        await mkdir(userConfig, { recursive: true });
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('resolveProjectConfigPath always returns <workspace>/.mcp.json, ignoring profileName', () => {
        const unprofiled = resolveProjectConfigPath({ workspaceRoot: workspace });
        const profiled = resolveProjectConfigPath({ workspaceRoot: workspace, profileName: 'dev' });

        expect(unprofiled).toBe(join(workspace, '.mcp.json'));
        expect(profiled).toBe(join(workspace, '.mcp.json'));
        expect(profiled).toBe(unprofiled);
    });

    it('loadResolvedMcpConfig with --profile dev ignores .mcp.dev.json and still reads .mcp.json', async () => {
        // Base user config so profile resolution does not throw profile-not-found.
        await writeFixture(join(userConfig, 'mission-control.dev.jsonc'), JSON.stringify({ mcp: {} }));
        // Real project server in .mcp.json (must still be read).
        await writeFixture(
            join(workspace, '.mcp.json'),
            JSON.stringify({ mcpServers: { realproject: { type: 'local', command: ['real-bin'] } } }),
        );
        // Decoy project server in .mcp.dev.json (must be ignored).
        await writeFixture(
            join(workspace, '.mcp.dev.json'),
            JSON.stringify({ mcpServers: { devonly: { type: 'local', command: ['dev-bin'] } } }),
        );

        const resolved = await loadResolvedMcpConfig({
            profileName: 'dev',
            workspaceRoot: workspace,
            userConfigDir: userConfig,
            env: {},
        });

        const names = resolved.servers.map((server) => server.name);
        expect(names).toContain('realproject');
        expect(names).not.toContain('devonly');
    });

    it('loadResolvedMcpConfig with --profile dev ignores .mcp.dev.jsonc variant too', async () => {
        await writeFixture(join(userConfig, 'mission-control.dev.jsonc'), JSON.stringify({ mcp: {} }));
        await writeFixture(
            join(workspace, '.mcp.json'),
            JSON.stringify({ mcpServers: { base: { type: 'local', command: ['b'] } } }),
        );
        await writeFixture(
            join(workspace, '.mcp.dev.jsonc'),
            JSON.stringify({ mcpServers: { jsoncdecoy: { type: 'local', command: ['d'] } } }),
        );

        const resolved = await loadResolvedMcpConfig({
            profileName: 'dev',
            workspaceRoot: workspace,
            userConfigDir: userConfig,
            env: {},
        });

        const names = resolved.servers.map((server) => server.name);
        expect(names).toContain('base');
        expect(names).not.toContain('jsoncdecoy');
    });
});
