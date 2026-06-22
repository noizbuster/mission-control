import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowRegistry } from '../workflows/workflow-registry.js';
import { PluginManager } from './plugin-manager.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VALID_MANIFEST = JSON.stringify({
    name: 'test-plugin',
    version: '0.1.0',
    description: 'integration test plugin',
    provides: {
        skills: true,
        workflows: true,
        categories: true,
        modes: true,
    },
});

const VALID_SKILL_MD = `---
name: test-skill
description: A minimal test skill
---
# Test Skill

This is a test skill body.
`;

const VALID_WORKFLOW_JSON = JSON.stringify({
    name: 'test-workflow',
    description: 'A minimal test workflow',
    graph: {
        id: 'test-workflow',
        entryNodeId: 'start',
        nodes: [{ id: 'start', kind: 'llm' }],
        edges: [],
        rules: [],
        policies: [],
    },
});

const VALID_CATEGORY_JSON = JSON.stringify({
    id: 'custom-researcher',
    permissions: ['read', 'network'],
    systemPromptAddendum: 'Research thoroughly.',
    tools: ['read', 'grep', 'webfetch'],
});

const VALID_MODE_JSON = JSON.stringify({
    id: 'custom-readonly',
    systemPromptOverlay: 'Never modify files.',
    policies: [{ action: 'write', resource: '**', effect: 'deny' }],
});

describe('PluginManager integration', () => {
    let tempHome: string;

    beforeEach(async () => {
        tempHome = await mkdtemp(join(tmpdir(), 'plugin-integration-'));
    });

    afterEach(async () => {
        await rm(tempHome, { recursive: true, force: true });
    });

    async function createTestPlugin(home: string): Promise<string> {
        const pluginDir = join(home, 'plugins', 'test-plugin');
        await mkdir(join(pluginDir, 'skills', 'test-skill'), { recursive: true });
        await mkdir(join(pluginDir, 'workflows'), { recursive: true });
        await mkdir(join(pluginDir, 'categories'), { recursive: true });
        await mkdir(join(pluginDir, 'modes'), { recursive: true });

        await writeFile(join(pluginDir, 'plugin.json'), VALID_MANIFEST, 'utf8');
        await writeFile(join(pluginDir, 'skills', 'test-skill', 'SKILL.md'), VALID_SKILL_MD, 'utf8');
        await writeFile(join(pluginDir, 'workflows', 'test.workflow.json'), VALID_WORKFLOW_JSON, 'utf8');
        await writeFile(join(pluginDir, 'categories', 'custom.category.json'), VALID_CATEGORY_JSON, 'utf8');
        await writeFile(join(pluginDir, 'modes', 'custom.mode.json'), VALID_MODE_JSON, 'utf8');

        return pluginDir;
    }

    it('discovers a plugin and exposes its skill and workflow dirs', async () => {
        const pluginDir = await createTestPlugin(tempHome);

        const manager = new PluginManager({ pluginHome: tempHome });
        await manager.initialize();

        const plugins = manager.getPlugins();
        expect(plugins).toHaveLength(1);
        expect(plugins[0]?.manifest.name).toBe('test-plugin');
        expect(plugins[0]?.rootPath).toBe(pluginDir);

        const skillDirs = manager.getSkillDirs();
        expect(skillDirs).toHaveLength(1);
        expect(skillDirs[0]).toBe(join(pluginDir, 'skills'));

        const workflowDirs = manager.getWorkflowDirs();
        expect(workflowDirs).toHaveLength(1);
        expect(workflowDirs[0]).toBe(join(pluginDir, 'workflows'));
    });

    it('parses plugin categories via loadCategories', async () => {
        await createTestPlugin(tempHome);

        const manager = new PluginManager({ pluginHome: tempHome });
        await manager.initialize();

        const categories = await manager.loadCategories();
        expect(categories).toHaveLength(1);
        expect(categories[0]?.id).toBe('custom-researcher');
        expect(categories[0]?.permissions).toContain('read');
        expect(categories[0]?.permissions).toContain('network');
        expect(categories[0]?.systemPromptAddendum).toBe('Research thoroughly.');
        expect(categories[0]?.tools).toEqual(['read', 'grep', 'webfetch']);
    });

    it('parses plugin modes via loadModes', async () => {
        await createTestPlugin(tempHome);

        const manager = new PluginManager({ pluginHome: tempHome });
        await manager.initialize();

        const modes = await manager.loadModes();
        expect(modes).toHaveLength(1);
        expect(modes[0]?.id).toBe('custom-readonly');
        expect(modes[0]?.systemPromptOverlay).toBe('Never modify files.');
        expect(modes[0]?.policies).toHaveLength(1);
        expect(modes[0]?.policies[0]?.action).toBe('write');
        expect(modes[0]?.policies[0]?.resource).toBe('**');
        expect(modes[0]?.policies[0]?.effect).toBe('deny');
    });

    it('registers categories and modes into a WorkflowRegistry via registerInto', async () => {
        await createTestPlugin(tempHome);

        const manager = new PluginManager({ pluginHome: tempHome });
        await manager.initialize();

        const registry = new WorkflowRegistry();
        await manager.registerInto(registry);

        const category = registry.lookupCategory('custom-researcher');
        expect(category).toBeDefined();
        expect(category?.id).toBe('custom-researcher');

        const mode = registry.lookupMode('custom-readonly');
        expect(mode).toBeDefined();
        expect(mode?.id).toBe('custom-readonly');

        expect(registry.listCategories()).toHaveLength(1);
        expect(registry.listModes()).toHaveLength(1);
    });

    it('returns empty arrays when plugin home does not exist', async () => {
        const manager = new PluginManager({ pluginHome: join(tempHome, 'nonexistent') });
        await manager.initialize();

        expect(manager.getPlugins()).toHaveLength(0);
        expect(manager.getSkillDirs()).toHaveLength(0);
        expect(manager.getWorkflowDirs()).toHaveLength(0);
        expect(await manager.loadCategories()).toHaveLength(0);
        expect(await manager.loadModes()).toHaveLength(0);
    });

    it('skill dirs from plugins integrate with discoverSkills additionalSkillDirs', async () => {
        const { discoverSkills } = await import('../skills/skill-loader.js');
        await createTestPlugin(tempHome);

        const manager = new PluginManager({ pluginHome: tempHome });
        await manager.initialize();

        const skillDirs = manager.getSkillDirs();
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'plugin-ws-'));
        try {
            const result = await discoverSkills({
                workspaceRoot,
                additionalSkillDirs: skillDirs,
            });
            const testSkill = result.skills.find((s) => s.name === 'test-skill');
            expect(testSkill).toBeDefined();
            expect(testSkill?.sourceInfo.scopeId).toBe('project-plugin');
            expect(testSkill?.filePath).toContain('test-skill');
            expect(testSkill?.filePath).toContain('SKILL.md');
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('workflow dirs from plugins integrate with discoverWorkflows additionalWorkflowDirs', async () => {
        const { discoverWorkflows } = await import('../workflows/workflow-loader.js');
        await createTestPlugin(tempHome);

        const manager = new PluginManager({ pluginHome: tempHome });
        await manager.initialize();

        const workflowDirs = manager.getWorkflowDirs();
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'plugin-ws-'));
        try {
            const result = await discoverWorkflows({
                workspaceRoot,
                additionalWorkflowDirs: workflowDirs,
            });
            const testWorkflow = result.workflows.find((w) => w.name === 'test-workflow');
            expect(testWorkflow).toBeDefined();
            expect(testWorkflow?.graph.entryNodeId).toBe('start');
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });
});
