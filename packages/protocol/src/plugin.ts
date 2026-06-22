import { z } from 'zod';

/**
 * Plugin manifest schema.
 *
 * A plugin lives at `~/.gctrl/plugins/{name}/plugin.json`. The manifest declares
 * what the plugin provides (skills, workflows, categories, modes, mcp, tools,
 * nodes, lsp, context, subagents) via the `provides` map. Subdirectories are
 * consulted lazily by the plugin manager.
 *
 * Discovery mirrors `discoverSkills`/`discoverWorkflows`: never throws, denylist
 * reuse, symlink defense, size caps.
 */
export const PluginManifestSchema = z
    .object({
        name: z.string().min(1),
        version: z.string().min(1),
        description: z.string().optional(),
        author: z.string().optional(),
        homepage: z.string().optional(),
        provides: z
            .object({
                skills: z.boolean().default(false),
                workflows: z.boolean().default(false),
                categories: z.boolean().default(false),
                modes: z.boolean().default(false),
                mcp: z.boolean().default(false),
                tools: z.boolean().default(false),
                nodes: z.boolean().default(false),
                lsp: z.boolean().default(false),
                context: z.boolean().default(false),
                subagents: z.boolean().default(false),
            })
            .default({
                skills: false,
                workflows: false,
                categories: false,
                modes: false,
                mcp: false,
                tools: false,
                nodes: false,
                lsp: false,
                context: false,
                subagents: false,
            }),
    })
    .strict();
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/**
 * LSP server config for plugins. Declares a command + args + file extensions
 * so a future LSP transport can spawn the server and route matching files.
 */
export const PluginLspServerSchema = z
    .object({
        name: z.string().min(1),
        language: z.string().min(1),
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
        extensions: z.array(z.string()).default([]),
        timeoutMs: z.number().int().positive().default(30000),
    })
    .strict();
export type PluginLspServer = z.infer<typeof PluginLspServerSchema>;

/**
 * Declarative tool definition for plugins. May be backed by an MCP server
 * (`mcpServer`) or be a reference-only entry.
 */
export const PluginToolDefinitionSchema = z
    .object({
        name: z.string().min(1),
        description: z.string(),
        inputSchema: z.record(z.string(), z.unknown()),
        mcpServer: z.string().optional(),
        capability: z.string().default('read'),
    })
    .strict();
export type PluginToolDefinition = z.infer<typeof PluginToolDefinitionSchema>;

/**
 * Declarative node kind definition for plugins. Maps a `kind` string to a
 * built-in runner so graphs can reference plugin-provided node kinds.
 */
export const PluginNodeDefinitionSchema = z
    .object({
        kind: z.string().min(1),
        runner: z.enum(['llm', 'tool', 'memory', 'policy', 'parallel']).default('llm'),
        defaultConfig: z.record(z.string(), z.unknown()).default({}),
    })
    .strict();
export type PluginNodeDefinition = z.infer<typeof PluginNodeDefinitionSchema>;

/**
 * Declarative context source definition for plugins.
 */
export const PluginContextSourceSchema = z
    .object({
        key: z.string().min(1),
        description: z.string(),
        baselineFile: z.string().min(1),
    })
    .strict();
export type PluginContextSource = z.infer<typeof PluginContextSourceSchema>;

/**
 * Declarative sub-agent definition for plugins.
 */
export const PluginSubAgentSchema = z
    .object({
        id: z.string().min(1),
        name: z.string().min(1),
        systemPrompt: z.string(),
        model: z.string().optional(),
        tools: z.array(z.string()).default([]),
    })
    .strict();
export type PluginSubAgent = z.infer<typeof PluginSubAgentSchema>;

/**
 * A discovered plugin descriptor: the validated manifest plus the absolute
 * path to the plugin directory.
 */
export const PluginDescriptorSchema = z
    .object({
        manifest: PluginManifestSchema,
        rootPath: z.string().min(1),
    })
    .strict();
export type PluginDescriptor = z.infer<typeof PluginDescriptorSchema>;

export const PLUGIN_DISCOVERY_DIAGNOSTIC_SEVERITIES = ['error', 'warning', 'info'] as const;
export const PluginDiscoveryDiagnosticSeveritySchema = z.enum(PLUGIN_DISCOVERY_DIAGNOSTIC_SEVERITIES);
export type PluginDiscoveryDiagnosticSeverity = z.infer<typeof PluginDiscoveryDiagnosticSeveritySchema>;

/**
 * A non-fatal diagnostic emitted by the plugin loader when a discovered plugin
 * fails validation or violates a constraint. The loader never throws; it collects
 * these and surfaces them to the CLI/desktop, mirroring the workflow loader.
 */
export const PluginDiscoveryDiagnosticSchema = z
    .object({
        pluginName: z.string().min(1),
        severity: PluginDiscoveryDiagnosticSeveritySchema,
        code: z.string().min(1),
        message: z.string().min(1),
        path: z.string().min(1).optional(),
    })
    .strict();
export type PluginDiscoveryDiagnostic = z.infer<typeof PluginDiscoveryDiagnosticSchema>;
