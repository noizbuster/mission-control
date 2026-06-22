/**
 * End-to-end contract test for the agent system (todo 40).
 *
 * Twelve independent assertions covering every agent-system invariant:
 * discovery (4-scope first-wins + 9 bundled templates), the markdown+YAML
 * parser and its three on-disk `tools` dialects, the 9 cross-harness
 * importers wired through `registerBuiltinProviders`, the two legacy
 * `task()` signature adapters, the `mctrl/<role>` model-alias parse, the
 * tier-based approval resolver, the recursion-depth gate, and the
 * parent-spawns allowlist policy.
 *
 * Each `it` is self-contained: a failure in one assertion does not skip
 * the others. Discovery tests use isolated temp directories (mkdtemp +
 * cleanup); pure-function tests need no I/O.
 */
import { describe, expect, it } from 'vitest';
import { resolveApproval } from '../packages/core/src/agents/approval-tier.js';
import { CapabilityRegistry } from '../packages/core/src/agents/capability/index.js';
import { adaptLegacyCategoryInput, adaptLegacySimpleInput } from '../packages/core/src/agents/legacy-compat.js';
import { parseModelAlias } from '../packages/core/src/agents/model-roles.js';
import { CROSS_HARNESS_PROVIDERS, registerBuiltinProviders } from '../packages/core/src/agents/providers/index.js';
import { canSpawnAtDepth } from '../packages/core/src/agents/recursion-policy.js';
import { canSpawn } from '../packages/core/src/agents/spawn-policy.js';
import type { AgentDefinition } from '../packages/core/src/index.js';
import { AgentIndex, discoverAgents, parseAgentFile } from '../packages/core/src/index.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BUNDLED_AGENT_NAMES: readonly string[] = [
    'deep',
    'explore',
    'librarian',
    'metis',
    'momus',
    'oracle',
    'quick',
    'ultrabrain',
    'visual-engineering',
];

const EXPECTED_PROVIDER_IDS: readonly string[] = [
    'claude-code',
    'cursor',
    'codex',
    'gemini',
    'cline',
    'windsurf',
    'vscode',
    'github-copilot',
    'opencode',
];

interface TempArea {
    readonly root: string;
    readonly workspace: string;
    readonly userConfig: string;
}

async function makeTempArea(): Promise<TempArea> {
    const root = await mkdtemp(join(tmpdir(), 'agent-contract-'));
    const workspace = join(root, 'workspace');
    const userConfig = join(root, 'user-config');
    await mkdir(workspace, { recursive: true });
    await mkdir(userConfig, { recursive: true });
    return { root, workspace, userConfig };
}

async function writeAgentFile(baseDir: string, relativePath: string, content: string): Promise<void> {
    const filePath = join(baseDir, relativePath);
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, content, 'utf8');
}

function minimalParent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
    return {
        name: 'contract-parent',
        description: 'contract test parent',
        systemPrompt: 'contract parent body',
        source: 'bundled',
        ...overrides,
    };
}

describe('agent system contract', () => {
    it('1. discoverAgents surfaces all 9 bundled agents in AgentIndex', async () => {
        const area = await makeTempArea();
        try {
            const result = await discoverAgents({
                workspaceRoot: area.workspace,
                userConfigDir: area.userConfig,
            });
            const index = new AgentIndex(result);

            expect(index.names().length).toBe(BUNDLED_AGENT_NAMES.length);
            for (const name of BUNDLED_AGENT_NAMES) {
                const agent = index.lookup(name);
                expect(agent, `bundled agent '${name}' should be present`).toBeDefined();
                expect(agent?.source).toBe('bundled');
                expect(agent?.systemPrompt.length).toBeGreaterThan(0);
            }
        } finally {
            await rm(area.root, { recursive: true, force: true });
        }
    });

    it('2. project scope overrides bundled agent of the same name (first-wins)', async () => {
        const area = await makeTempArea();
        try {
            await writeAgentFile(
                area.workspace,
                '.mctrl/agents/quick.md',
                '---\nname: quick\ndescription: Project override of bundled quick.\n---\n\nproject-scoped quick body\n',
            );

            const result = await discoverAgents({
                workspaceRoot: area.workspace,
                userConfigDir: area.userConfig,
            });
            const index = new AgentIndex(result);

            const quick = index.lookup('quick');
            expect(quick, 'overridden quick should exist').toBeDefined();
            expect(quick?.source).toBe('project');
            expect(quick?.description).toBe('Project override of bundled quick.');
            expect(quick?.systemPrompt).toBe('project-scoped quick body');

            const duplicate = index.diagnostics.find((d) => d.code === 'duplicate_name' && d.agentName === 'quick');
            expect(duplicate, 'bundled quick should be shadowed with a duplicate_name diagnostic').toBeDefined();
        } finally {
            await rm(area.root, { recursive: true, force: true });
        }
    });

    it('3. parseAgentFile normalizes the three on-disk tools formats', () => {
        const csv = parseAgentFile(
            '/tmp/csv-agent.md',
            '---\nname: csv-agent\ndescription: csv\ntools: "read, search, find"\n---\n\nbody\n',
            'bundled',
        );
        expect(csv.tools).toEqual(['read', 'search', 'find']);

        const arrayForm = parseAgentFile(
            '/tmp/array-agent.md',
            '---\nname: array-agent\ndescription: array\ntools:\n  - read\n  - search\n---\n\nbody\n',
            'bundled',
        );
        expect(arrayForm.tools).toEqual(['read', 'search']);

        const mapForm = parseAgentFile(
            '/tmp/map-agent.md',
            '---\nname: map-agent\ndescription: map\ntools:\n  "/": false\n  search: true\n  read: true\n---\n\nbody\n',
            'bundled',
        );
        expect(mapForm.tools).toEqual(['search', 'read']);
    });

    it('4. registerBuiltinProviders wires all 9 cross-harness providers', () => {
        expect(CROSS_HARNESS_PROVIDERS.length).toBe(EXPECTED_PROVIDER_IDS.length);

        const registry = new CapabilityRegistry();
        registerBuiltinProviders(registry);
        const registered = registry.list();

        expect(registered.length).toBe(EXPECTED_PROVIDER_IDS.length);
        const registeredIds = registered.map((p) => p.id).sort();
        expect(registeredIds).toEqual([...EXPECTED_PROVIDER_IDS].sort());
        for (const provider of registered) {
            expect(provider.priority).toBe(50);
        }
    });

    it('5. adaptLegacyCategoryInput maps {category, prompt} onto {agent, assignment}', () => {
        const result = adaptLegacyCategoryInput({ category: 'deep', prompt: 'X' });
        expect(result).toEqual({ agent: 'deep', assignment: 'X' });
    });

    it('6. adaptLegacySimpleInput maps {description, prompt} onto the new signature with role', () => {
        const result = adaptLegacySimpleInput({ description: 'D', prompt: 'P' });
        expect(result).toEqual({ agent: 'deep', assignment: 'P', role: 'D' });
    });

    it('7. parseModelAlias resolves mctrl/<role> to the typed role', () => {
        expect(parseModelAlias('mctrl/slow')).toBe('slow');
    });

    it('8. resolveApproval: yolo mode auto-approves exec-tier tools', () => {
        const result = resolveApproval({ toolTier: 'exec', mode: 'yolo' });
        expect(result.requiresApproval).toBe(false);
    });

    it('9. resolveApproval: always-ask mode prompts even for read-tier tools', () => {
        const result = resolveApproval({ toolTier: 'read', mode: 'always-ask' });
        expect(result.requiresApproval).toBe(true);
    });

    it('10. canSpawnAtDepth enforces the strict less-than boundary at max depth', () => {
        expect(canSpawnAtDepth(2, 2)).toBe(false);
    });

    it('11. canSpawn denies every child when the parent declares no spawns', () => {
        const parent = minimalParent();
        expect(canSpawn(parent, 'quick').allowed).toBe(false);
        expect(canSpawn(parent, 'deep').allowed).toBe(false);
    });

    it('12. canSpawn allows all children under spawns="*" except self-recursion', () => {
        const starParent = minimalParent({ spawns: '*' });
        expect(canSpawn(starParent, 'quick').allowed).toBe(true);
        expect(canSpawn(starParent, 'oracle').allowed).toBe(true);

        const selfRecursion = canSpawn(starParent, 'quick', { parentId: 'p1', childId: 'p1' });
        expect(selfRecursion.allowed).toBe(false);
    });
});
