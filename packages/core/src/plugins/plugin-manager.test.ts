import { describe, expect, it } from 'vitest';
import { WorkflowRegistry } from '../workflows/workflow-registry.js';
import { discoverPlugins, loadPluginManifest } from './plugin-loader.js';
import { PluginManager } from './plugin-manager.js';
import { ensurePluginDirs, resolvePluginDir, resolvePluginHome } from './plugin-paths.js';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function makeTempHome(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'plugin-test-'));
}

async function makePlugin(home: string, name: string, manifest: Record<string, unknown>): Promise<string> {
    const dir = resolvePluginDir(name, home);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest), 'utf8');
    return dir;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, JSON.stringify(data), 'utf8');
}

const validManifest = (name: string, provides: Record<string, boolean> = {}): Record<string, unknown> => ({
    name,
    version: '1.0.0',
    provides,
});

describe('plugin-paths', () => {
    it('resolvePluginHome uses envOverride when provided', () => {
        expect(resolvePluginHome('/custom/home')).toBe('/custom/home');
    });

    it('resolvePluginHome falls back to GCTRL_HOME env', () => {
        const saved = process.env['GCTRL_HOME'];
        process.env['GCTRL_HOME'] = '/env/home';
        try {
            expect(resolvePluginHome()).toBe('/env/home');
        } finally {
            if (saved === undefined) {
                delete process.env['GCTRL_HOME'];
            } else {
                process.env['GCTRL_HOME'] = saved;
            }
        }
    });

    it('resolvePluginDir joins home/plugins/name', () => {
        expect(resolvePluginDir('my-plugin', '/home')).toBe('/home/plugins/my-plugin');
    });

    it('ensurePluginDirs creates home and plugins directory', async () => {
        const home = await makeTempHome();
        const saved = process.env['GCTRL_HOME'];
        process.env['GCTRL_HOME'] = home;
        try {
            const pluginsDir = await ensurePluginDirs();
            expect(pluginsDir).toBe(join(home, 'plugins'));
        } finally {
            if (saved === undefined) {
                delete process.env['GCTRL_HOME'];
            } else {
                process.env['GCTRL_HOME'] = saved;
            }
            await rm(home, { recursive: true, force: true });
        }
    });
});

describe('discoverPlugins', () => {
    it('finds a valid plugin and returns its descriptor', async () => {
        const home = await makeTempHome();
        try {
            await makePlugin(home, 'alpha', validManifest('alpha', { skills: true }));
            const result = await discoverPlugins({ pluginHome: home });
            expect(result.plugins).toHaveLength(1);
            expect(result.plugins[0]?.manifest.name).toBe('alpha');
            expect(result.plugins[0]?.manifest.provides.skills).toBe(true);
            expect(result.diagnostics).toHaveLength(0);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('rejects a broken manifest with a diagnostic and never throws', async () => {
        const home = await makeTempHome();
        try {
            await makePlugin(home, 'broken', { version: '1.0.0' });
            const result = await discoverPlugins({ pluginHome: home });
            expect(result.plugins).toHaveLength(0);
            expect(result.diagnostics).toHaveLength(1);
            expect(result.diagnostics[0]?.code).toBe('validation_error');
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('skips a directory with no plugin.json silently (drop, no diagnostic)', async () => {
        const home = await makeTempHome();
        try {
            await mkdir(join(home, 'plugins', 'empty-plugin'), { recursive: true });
            const result = await discoverPlugins({ pluginHome: home });
            expect(result.plugins).toHaveLength(0);
            expect(result.diagnostics).toHaveLength(0);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('returns empty when plugins directory does not exist', async () => {
        const home = await makeTempHome();
        try {
            const result = await discoverPlugins({ pluginHome: home });
            expect(result.plugins).toHaveLength(0);
            expect(result.diagnostics).toHaveLength(0);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('first-wins on duplicate plugin names', async () => {
        const home = await makeTempHome();
        try {
            await makePlugin(home, 'dir-a', validManifest('shared-name'));
            await makePlugin(home, 'dir-b', validManifest('shared-name'));
            const result = await discoverPlugins({ pluginHome: home });
            expect(result.plugins).toHaveLength(1);
            expect(result.diagnostics).toHaveLength(1);
            expect(result.diagnostics[0]?.code).toBe('duplicate_name');
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('skips symlinked plugin directories', async () => {
        const home = await makeTempHome();
        try {
            const real = await makePlugin(home, 'real', validManifest('real'));
            await symlink(real, join(home, 'plugins', 'link'));
            const result = await discoverPlugins({ pluginHome: home });
            expect(result.plugins).toHaveLength(1);
            expect(result.plugins[0]?.manifest.name).toBe('real');
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('rejects oversized manifest (64KB cap)', async () => {
        const home = await makeTempHome();
        try {
            const dir = resolvePluginDir('big', home);
            await mkdir(dir, { recursive: true });
            const huge = { name: 'big', version: '1.0.0', description: 'x'.repeat(70 * 1024) };
            await writeFile(join(dir, 'plugin.json'), JSON.stringify(huge), 'utf8');
            const result = await discoverPlugins({ pluginHome: home });
            expect(result.plugins).toHaveLength(0);
            expect(result.diagnostics).toHaveLength(1);
            expect(result.diagnostics[0]?.code).toBe('size_exceeded');
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('supports JSONC comments in plugin.json', async () => {
        const home = await makeTempHome();
        try {
            const dir = resolvePluginDir('jsonc', home);
            await mkdir(dir, { recursive: true });
            await writeFile(
                join(dir, 'plugin.json'),
                '{\n  // this is a comment\n  "name": "jsonc",\n  "version": "1.0.0"\n}',
                'utf8',
            );
            const result = await discoverPlugins({ pluginHome: home });
            expect(result.plugins).toHaveLength(1);
            expect(result.plugins[0]?.manifest.name).toBe('jsonc');
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });
});

describe('loadPluginManifest', () => {
    it('loads and validates a manifest', async () => {
        const home = await makeTempHome();
        try {
            const dir = await makePlugin(home, 'single', validManifest('single', { modes: true }));
            const manifest = await loadPluginManifest(dir);
            expect(manifest.name).toBe('single');
            expect(manifest.provides.modes).toBe(true);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('throws when plugin.json is missing', async () => {
        const home = await makeTempHome();
        try {
            const dir = resolvePluginDir('nope', home);
            await mkdir(dir, { recursive: true });
            await expect(loadPluginManifest(dir)).rejects.toThrow('not found');
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });
});

describe('PluginManager', () => {
    it('getSkillDirs and getWorkflowDirs collect correct paths', async () => {
        const home = await makeTempHome();
        try {
            await makePlugin(home, 'p1', validManifest('p1', { skills: true }));
            await makePlugin(home, 'p2', validManifest('p2', { workflows: true }));
            await makePlugin(home, 'p3', validManifest('p3', { skills: true, workflows: true }));
            const mgr = new PluginManager({ pluginHome: home });
            await mgr.initialize();
            const skillDirs = mgr.getSkillDirs();
            const workflowDirs = mgr.getWorkflowDirs();
            expect(skillDirs).toHaveLength(2);
            expect(skillDirs.some((d) => d.endsWith('plugins/p1/skills'))).toBe(true);
            expect(skillDirs.some((d) => d.endsWith('plugins/p3/skills'))).toBe(true);
            expect(workflowDirs).toHaveLength(2);
            expect(workflowDirs.some((d) => d.endsWith('plugins/p2/workflows'))).toBe(true);
            expect(workflowDirs.some((d) => d.endsWith('plugins/p3/workflows'))).toBe(true);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('loadCategories and loadModes parse JSON files correctly', async () => {
        const home = await makeTempHome();
        try {
            const dir = await makePlugin(
                home,
                'cat-mode',
                validManifest('cat-mode', { categories: true, modes: true }),
            );
            await writeJson(join(dir, 'categories', 'deep.json'), {
                id: 'deep',
                permissions: ['read', 'edit', 'bash'],
            });
            await writeJson(join(dir, 'modes', 'autopilot.json'), {
                id: 'autopilot',
            });
            const mgr = new PluginManager({ pluginHome: home });
            await mgr.initialize();
            const categories = await mgr.loadCategories();
            const modes = await mgr.loadModes();
            expect(categories).toHaveLength(1);
            expect(categories[0]?.id).toBe('deep');
            expect(categories[0]?.permissions).toEqual(['read', 'edit', 'bash']);
            expect(modes).toHaveLength(1);
            expect(modes[0]?.id).toBe('autopilot');
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('loadLspServers parses lsp.json', async () => {
        const home = await makeTempHome();
        try {
            const dir = await makePlugin(home, 'lsp-plugin', validManifest('lsp-plugin', { lsp: true }));
            await writeJson(join(dir, 'lsp.json'), [
                { name: 'tsserver', language: 'typescript', command: 'tsserver' },
                { name: 'rust-analyzer', language: 'rust', command: 'rust-analyzer' },
            ]);
            const mgr = new PluginManager({ pluginHome: home });
            await mgr.initialize();
            const servers = await mgr.loadLspServers();
            expect(servers).toHaveLength(2);
            expect(servers[0]?.name).toBe('tsserver');
            expect(servers[1]?.name).toBe('rust-analyzer');
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('loadToolDefinitions parses tools/*.json', async () => {
        const home = await makeTempHome();
        try {
            const dir = await makePlugin(home, 'tool-plugin', validManifest('tool-plugin', { tools: true }));
            await writeJson(join(dir, 'tools', 'search.json'), {
                name: 'search',
                description: 'search tool',
                inputSchema: { type: 'object' },
            });
            const mgr = new PluginManager({ pluginHome: home });
            await mgr.initialize();
            const tools = await mgr.loadToolDefinitions();
            expect(tools).toHaveLength(1);
            expect(tools[0]?.name).toBe('search');
            expect(tools[0]?.capability).toBe('read');
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('loadNodeDefinitions parses nodes/*.json', async () => {
        const home = await makeTempHome();
        try {
            const dir = await makePlugin(home, 'node-plugin', validManifest('node-plugin', { nodes: true }));
            await writeJson(join(dir, 'nodes', 'custom.json'), {
                kind: 'custom-node',
                runner: 'tool',
            });
            const mgr = new PluginManager({ pluginHome: home });
            await mgr.initialize();
            const nodes = await mgr.loadNodeDefinitions();
            expect(nodes).toHaveLength(1);
            expect(nodes[0]?.kind).toBe('custom-node');
            expect(nodes[0]?.runner).toBe('tool');
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('loadContextSources parses context/*.json', async () => {
        const home = await makeTempHome();
        try {
            const dir = await makePlugin(home, 'ctx-plugin', validManifest('ctx-plugin', { context: true }));
            await writeJson(join(dir, 'context', 'docs.json'), {
                key: 'docs',
                description: 'documentation source',
                baselineFile: 'docs/baseline.md',
            });
            const mgr = new PluginManager({ pluginHome: home });
            await mgr.initialize();
            const sources = await mgr.loadContextSources();
            expect(sources).toHaveLength(1);
            expect(sources[0]?.key).toBe('docs');
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('loadSubAgents parses subagents/*.json', async () => {
        const home = await makeTempHome();
        try {
            const dir = await makePlugin(home, 'agent-plugin', validManifest('agent-plugin', { subagents: true }));
            await writeJson(join(dir, 'subagents', 'researcher.json'), {
                id: 'researcher',
                name: 'Researcher',
                systemPrompt: 'You research things.',
            });
            const mgr = new PluginManager({ pluginHome: home });
            await mgr.initialize();
            const agents = await mgr.loadSubAgents();
            expect(agents).toHaveLength(1);
            expect(agents[0]?.id).toBe('researcher');
            expect(agents[0]?.tools).toEqual([]);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('getMcpConfigs reads mcp.json from each plugin', async () => {
        const home = await makeTempHome();
        try {
            const dir = await makePlugin(home, 'mcp-plugin', validManifest('mcp-plugin', { mcp: true }));
            await writeJson(join(dir, 'mcp.json'), {
                'fs-server': { type: 'local', command: ['npx', 'fs-server'] },
                'web-server': { type: 'remote', url: 'https://example.test/mcp' },
            });
            const mgr = new PluginManager({ pluginHome: home });
            await mgr.initialize();
            const configs = mgr.getMcpConfigs();
            expect(configs).toHaveLength(1);
            expect(configs[0]?.type).toBe('local');
            expect(configs[0]?.command).toEqual(['npx', 'fs-server']);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('getMcpConfigs returns empty when plugin provides.mcp is false', async () => {
        const home = await makeTempHome();
        try {
            await makePlugin(home, 'no-mcp', validManifest('no-mcp'));
            const mgr = new PluginManager({ pluginHome: home });
            await mgr.initialize();
            expect(mgr.getMcpConfigs()).toHaveLength(0);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('getDiagnostics surfaces discovery errors', async () => {
        const home = await makeTempHome();
        try {
            await makePlugin(home, 'broken', { version: '1.0.0' });
            const mgr = new PluginManager({ pluginHome: home });
            await mgr.initialize();
            const diags = mgr.getDiagnostics();
            expect(diags.length).toBeGreaterThanOrEqual(1);
            expect(diags.some((d) => d.pluginName === 'broken')).toBe(true);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('registerInto feeds categories and modes into WorkflowRegistry', async () => {
        const home = await makeTempHome();
        try {
            const dir = await makePlugin(home, 'reg', validManifest('reg', { categories: true, modes: true }));
            await writeJson(join(dir, 'categories', 'quick.json'), { id: 'quick', permissions: ['read'] });
            await writeJson(join(dir, 'modes', 'strict.json'), { id: 'strict' });
            const mgr = new PluginManager({ pluginHome: home });
            await mgr.initialize();
            const registry = new WorkflowRegistry();
            await mgr.registerInto(registry);
            expect(registry.lookupCategory('quick')).toBeDefined();
            expect(registry.lookupMode('strict')).toBeDefined();
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it('empty plugin home returns empty plugins and no diagnostics', async () => {
        const home = await makeTempHome();
        try {
            const mgr = new PluginManager({ pluginHome: home });
            await mgr.initialize();
            expect(mgr.getPlugins()).toHaveLength(0);
            expect(mgr.getDiagnostics()).toHaveLength(0);
            expect(mgr.getSkillDirs()).toHaveLength(0);
            expect(mgr.getMcpConfigs()).toHaveLength(0);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });
});
