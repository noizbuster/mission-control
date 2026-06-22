import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverAgents } from '../agent-loader.js';
import { CapabilityRegistry } from '../capability/index.js';
import type { LoadContext } from '../capability/types.js';
import { CROSS_HARNESS_PROVIDERS, registerBuiltinProviders } from './index.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type TempArea = { readonly root: string; readonly workspace: string; readonly userConfig: string };

const EXPECTED_PROVIDER_IDS = [
    'claude-code',
    'cursor',
    'codex',
    'gemini',
    'cline',
    'windsurf',
    'vscode',
    'github-copilot',
    'opencode',
] as const;

async function makeTempArea(): Promise<TempArea> {
    const root = await mkdtemp(join(tmpdir(), 'providers-test-'));
    const workspace = join(root, 'workspace');
    const userConfig = join(root, 'user-config');
    await mkdir(workspace, { recursive: true });
    await mkdir(userConfig, { recursive: true });
    return { root, workspace, userConfig };
}

async function writeAgent(baseDir: string, relativePath: string, content: string): Promise<void> {
    const filePath = join(baseDir, relativePath);
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, content, 'utf8');
}

function validAgentMd(name: string, description?: string): string {
    const desc = description ?? `Agent ${name}.`;
    return `---\nname: ${name}\ndescription: ${desc}\n---\n\nYou are the ${name} agent.\n`;
}

describe('registerBuiltinProviders', () => {
    it('(a) registers all 9 cross-harness providers', () => {
        const registry = new CapabilityRegistry();
        registerBuiltinProviders(registry);

        expect(registry.list()).toHaveLength(9);

        const ids = registry.list().map((p) => p.id);
        for (const expectedId of EXPECTED_PROVIDER_IDS) {
            expect(ids).toContain(expectedId);
        }
    });

    it('all registered providers have priority 50', () => {
        const registry = new CapabilityRegistry();
        registerBuiltinProviders(registry);

        for (const provider of registry.list()) {
            expect(provider.priority).toBe(50);
        }
    });

    it('CROSS_HARNESS_PROVIDERS exports exactly 9 entries matching the registry', () => {
        expect(CROSS_HARNESS_PROVIDERS).toHaveLength(9);
        const registry = new CapabilityRegistry();
        registerBuiltinProviders(registry);
        expect(registry.list()).toEqual([...CROSS_HARNESS_PROVIDERS]);
    });
});

describe('provider priority dedup', () => {
    let area: TempArea;

    beforeEach(async () => {
        area = await makeTempArea();
    });

    afterEach(async () => {
        await rm(area.root, { recursive: true, force: true });
    });

    it('(b) builtin (priority 100) shadows cross-harness (priority 50) on name conflict', async () => {
        await writeAgent(
            area.workspace,
            '.mctrl/agents/shared.md',
            validAgentMd('shared', 'From builtin project scope.'),
        );
        await writeAgent(area.workspace, '.claude/agents/shared.md', validAgentMd('shared', 'From claude harness.'));

        const ctx: LoadContext = { workspaceRoot: area.workspace, userConfigDir: area.userConfig };
        const registry = new CapabilityRegistry();

        const builtinProvider = {
            id: 'builtin-mock',
            displayName: 'Mock Builtin',
            description: 'test',
            priority: 100,
            async loadAgents() {
                return [
                    {
                        name: 'shared',
                        description: 'From builtin project scope.',
                        systemPrompt: 'builtin',
                        source: 'project' as const,
                    },
                ];
            },
        };
        registry.registerProvider(builtinProvider);
        registry.registerProvider({
            id: 'claude-mock',
            displayName: 'Mock Claude',
            description: 'test',
            priority: 50,
            async loadAgents() {
                return [
                    {
                        name: 'shared',
                        description: 'From claude harness.',
                        systemPrompt: 'claude',
                        source: 'plugin' as const,
                    },
                ];
            },
        });

        const result = await registry.loadAll(ctx);

        const shared = result.agents.find((a) => a.name === 'shared');
        expect(shared).toBeDefined();
        expect(shared?.description).toBe('From builtin project scope.');
        expect(shared?.source).toBe('project');

        const dups = result.diagnostics.filter((d) => d.code === 'duplicate_name' && d.agentName === 'shared');
        expect(dups).toHaveLength(1);
    });

    it('(b2) two cross-harness providers with same name: first-registered wins via discoverAgents', async () => {
        await writeAgent(area.workspace, '.claude/agents/dup.md', validAgentMd('dup', 'from claude'));
        await writeAgent(area.workspace, '.cursor/agents/dup.md', validAgentMd('dup', 'from cursor'));

        const result = await discoverAgents({
            workspaceRoot: area.workspace,
            userConfigDir: area.userConfig,
            includeBundled: false,
        });

        const dupAgents = result.agents.filter((a) => a.name === 'dup');
        expect(dupAgents).toHaveLength(1);
        expect(dupAgents[0]?.description).toBe('from claude');

        const dup = result.diagnostics.find((d) => d.code === 'duplicate_name' && d.agentName === 'dup');
        expect(dup).toBeDefined();
    });
});

describe('disabled provider', () => {
    let area: TempArea;

    beforeEach(async () => {
        area = await makeTempArea();
    });

    afterEach(async () => {
        await rm(area.root, { recursive: true, force: true });
    });

    it('(c) disabled provider agents absent, other provider agents present', async () => {
        await writeAgent(area.workspace, '.claude/agents/claude-only.md', validAgentMd('claude-only'));
        await writeAgent(area.workspace, '.cursor/agents/cursor-only.md', validAgentMd('cursor-only'));

        const ctx: LoadContext = { workspaceRoot: area.workspace, userConfigDir: area.userConfig };
        const registry = new CapabilityRegistry();
        registerBuiltinProviders(registry);
        registry.disableProvider('claude-code');

        const result = await registry.loadAll(ctx);

        const names = result.agents.map((a) => a.name);
        expect(names).not.toContain('claude-only');
        expect(names).toContain('cursor-only');
    });
});

describe('discoverAgents integration', () => {
    let area: TempArea;

    beforeEach(async () => {
        area = await makeTempArea();
    });

    afterEach(async () => {
        await rm(area.root, { recursive: true, force: true });
    });

    it('(d) returns { agents, diagnostics } shape with cross-harness agents merged', async () => {
        await writeAgent(area.workspace, '.claude/agents/researcher.md', validAgentMd('researcher'));
        await writeAgent(area.workspace, '.codex/agents/builder.md', validAgentMd('builder'));
        await writeAgent(area.workspace, '.mctrl/agents/local.md', validAgentMd('local'));

        const result = await discoverAgents({
            workspaceRoot: area.workspace,
            userConfigDir: area.userConfig,
            includeBundled: false,
        });

        expect(result).toHaveProperty('agents');
        expect(result).toHaveProperty('diagnostics');
        expect(Array.isArray(result.agents)).toBe(true);
        expect(Array.isArray(result.diagnostics)).toBe(true);

        const names = new Set(result.agents.map((a) => a.name));
        expect(names.has('researcher')).toBe(true);
        expect(names.has('builder')).toBe(true);
        expect(names.has('local')).toBe(true);
    });

    it('(d2) discoverAgents with empty workspace and no bundled returns empty result', async () => {
        const result = await discoverAgents({
            workspaceRoot: area.workspace,
            userConfigDir: area.userConfig,
            includeBundled: false,
        });

        expect(result.agents).toEqual([]);
        expect(result.diagnostics).toEqual([]);
    });
});
