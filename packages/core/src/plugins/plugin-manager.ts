/**
 * Plugin Manager: orchestrates plugin discovery and lazy content loading.
 *
 * `initialize()` discovers all plugins under `{pluginHome}/plugins/` and
 * pre-loads MCP configs (needed for the synchronous `getMcpConfigs()`).
 * All other content (categories, modes, tools, nodes, context, subagents,
 * lsp) is loaded lazily by the `load*()` methods.
 *
 * The manager COLLECTS paths and content; it does not replace existing
 * discovery loaders. Callers feed `getSkillDirs()` into `discoverSkills`,
 * `getWorkflowDirs()` into `discoverWorkflows`, etc.
 */
import {
    type Category,
    CategorySchema,
    type LocalMcpConfigEntry,
    McpConfigSchema,
    type Mode,
    ModeSchema,
    type PluginContextSource,
    PluginContextSourceSchema,
    type PluginDescriptor,
    type PluginDiscoveryDiagnostic,
    type PluginLspServer,
    PluginLspServerSchema,
    type PluginNodeDefinition,
    PluginNodeDefinitionSchema,
    type PluginSubAgent,
    PluginSubAgentSchema,
    type PluginToolDefinition,
    PluginToolDefinitionSchema,
} from '@mission-control/protocol';
import type { ZodType } from 'zod';
import { stripJsoncComments } from '../workflows/jsonc-parser.js';
import { WorkflowRegistry } from '../workflows/workflow-registry.js';
import { discoverPlugins } from './plugin-loader.js';
import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

type PluginContentSubdir = 'categories' | 'modes' | 'tools' | 'nodes' | 'context' | 'subagents';

export interface PluginManagerOptions {
    readonly pluginHome?: string;
    readonly workspaceRoot?: string;
    readonly userConfigDir?: string;
}

type ValidationError = {
    readonly issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey>; readonly message: string }>;
};

type ParsedJsonFile = { readonly data: unknown; readonly path: string };

export class PluginManager {
    private readonly pluginHome: string | undefined;
    private readonly workspaceRoot: string | undefined;
    private readonly userConfigDir: string | undefined;
    private plugins: readonly PluginDescriptor[] = [];
    private diagnostics: PluginDiscoveryDiagnostic[] = [];
    private mcpConfigs: LocalMcpConfigEntry[] = [];

    constructor(options: PluginManagerOptions = {}) {
        this.pluginHome = options.pluginHome;
        this.workspaceRoot = options.workspaceRoot;
        this.userConfigDir = options.userConfigDir;
    }

    async initialize(): Promise<void> {
        const discoveryOpts = this.pluginHome !== undefined ? { pluginHome: this.pluginHome } : {};
        const result = await discoverPlugins(discoveryOpts);
        this.plugins = result.plugins;
        this.diagnostics = [...result.diagnostics];
        await this.preloadMcpConfigs();
    }

    getPlugins(): readonly PluginDescriptor[] {
        return [...this.plugins];
    }

    getDiagnostics(): readonly PluginDiscoveryDiagnostic[] {
        return [...this.diagnostics];
    }

    getSkillDirs(): readonly string[] {
        return this.plugins.filter((p) => p.manifest.provides.skills).map((p) => join(p.rootPath, 'skills'));
    }

    getWorkflowDirs(): readonly string[] {
        return this.plugins.filter((p) => p.manifest.provides.workflows).map((p) => join(p.rootPath, 'workflows'));
    }

    getMcpConfigs(): readonly LocalMcpConfigEntry[] {
        return [...this.mcpConfigs];
    }

    async loadCategories(): Promise<readonly Category[]> {
        return this.loadFromSubdir('categories', CategorySchema);
    }

    async loadModes(): Promise<readonly Mode[]> {
        return this.loadFromSubdir('modes', ModeSchema);
    }

    async loadLspServers(): Promise<readonly PluginLspServer[]> {
        const results: PluginLspServer[] = [];
        for (const plugin of this.plugins) {
            if (!plugin.manifest.provides.lsp) continue;
            const data = await this.readJsonFile(join(plugin.rootPath, 'lsp.json'));
            if (data === undefined) continue;
            const items = Array.isArray(data) ? data : [data];
            for (const item of items) {
                const result = PluginLspServerSchema.safeParse(item);
                if (result.success) {
                    results.push(result.data);
                } else {
                    this.addValidationDiagnostic(plugin, 'lsp.json', result.error);
                }
            }
        }
        return results;
    }

    async loadToolDefinitions(): Promise<readonly PluginToolDefinition[]> {
        return this.loadFromSubdir('tools', PluginToolDefinitionSchema);
    }

    async loadNodeDefinitions(): Promise<readonly PluginNodeDefinition[]> {
        return this.loadFromSubdir('nodes', PluginNodeDefinitionSchema);
    }

    async loadContextSources(): Promise<readonly PluginContextSource[]> {
        return this.loadFromSubdir('context', PluginContextSourceSchema);
    }

    async loadSubAgents(): Promise<readonly PluginSubAgent[]> {
        return this.loadFromSubdir('subagents', PluginSubAgentSchema);
    }

    async registerInto(registry: WorkflowRegistry): Promise<void> {
        const [categories, modes] = await Promise.all([this.loadCategories(), this.loadModes()]);
        for (const category of categories) {
            registry.registerCategory(category);
        }
        for (const mode of modes) {
            registry.registerMode(mode);
        }
    }

    // --- private helpers ---

    private async loadFromSubdir<T>(subdir: PluginContentSubdir, schema: ZodType<T>): Promise<readonly T[]> {
        const results: T[] = [];
        for (const plugin of this.plugins) {
            if (!plugin.manifest.provides[subdir]) continue;
            const files = await this.readPluginJsonFiles(plugin, subdir);
            for (const file of files) {
                const result = schema.safeParse(file.data);
                if (result.success) {
                    results.push(result.data);
                } else {
                    this.addValidationDiagnostic(plugin, `${subdir}/`, result.error);
                }
            }
        }
        return results;
    }

    private async preloadMcpConfigs(): Promise<void> {
        for (const plugin of this.plugins) {
            if (!plugin.manifest.provides.mcp) continue;
            const data = await this.readJsonFile(join(plugin.rootPath, 'mcp.json'));
            if (data === undefined) continue;
            const result = McpConfigSchema.safeParse(data);
            if (!result.success) {
                this.addValidationDiagnostic(plugin, 'mcp.json', result.error);
                continue;
            }
            for (const entry of Object.values(result.data)) {
                if (entry.type === 'local') {
                    this.mcpConfigs.push(entry);
                }
            }
        }
    }

    private async readPluginJsonFiles(plugin: PluginDescriptor, subdir: string): Promise<readonly ParsedJsonFile[]> {
        const dir = join(plugin.rootPath, subdir);
        let entries: readonly Dirent[];
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return [];
        }
        const results: ParsedJsonFile[] = [];
        for (const entry of entries) {
            if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith('.json')) {
                continue;
            }
            const filePath = join(dir, entry.name);
            try {
                const contents = await readFile(filePath, 'utf8');
                results.push({ data: JSON.parse(stripJsoncComments(contents)), path: filePath });
            } catch (error: unknown) {
                this.diagnostics.push({
                    pluginName: plugin.manifest.name,
                    severity: 'warning',
                    code: 'content_parse_error',
                    message: instanceMessage(error),
                    path: filePath,
                });
            }
        }
        return results;
    }

    private async readJsonFile(filePath: string): Promise<unknown | undefined> {
        try {
            const contents = await readFile(filePath, 'utf8');
            return JSON.parse(stripJsoncComments(contents));
        } catch {
            return undefined;
        }
    }

    private addValidationDiagnostic(plugin: PluginDescriptor, location: string, error: ValidationError): void {
        const detail = error.issues.map((i) => `${i.path.map((p) => String(p)).join('.')}: ${i.message}`).join('; ');
        this.diagnostics.push({
            pluginName: plugin.manifest.name,
            severity: 'warning',
            code: 'content_validation_error',
            message: `${location}: ${detail}`,
            path: join(plugin.rootPath, location),
        });
    }
}

function instanceMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
