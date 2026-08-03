import { z } from 'zod';
import { MemoryBackendConfigSchema } from './memory';
import { SshHostsConfigSchema } from './ssh-config';

/**
 * MCP server configuration entries (opencode shape). Each named server is either a local stdio
 * child process (`type: 'local'`) or a remote HTTP/SSE endpoint (`type: 'remote'`).
 *
 * The `${VAR}` expansion of `command` / `environment` / `url` / `headers` values happens in the
 * mission-control config loader (`packages/core/src/tools/mcp/config.ts`), gated by the
 * `mcp_env_allowlist`. This schema describes the on-disk shape BEFORE expansion, so a literal
 * `${SECRET}` token passes schema validation; the loader decides whether to expand it.
 *
 * `timeoutMs` overrides the per-call MCP client deadline (default 5000ms; see
 * `packages/core/src/tools/mcp/deadline.ts`). `enabled` defaults to `true` when absent; disabled
 * servers are skipped at surfacing time (todo 7).
 */

const LocalMcpConfigEntrySchema = z.object({
    type: z.literal('local'),
    command: z.array(z.string()).min(1),
    environment: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
});

const RemoteMcpConfigEntrySchema = z.object({
    type: z.literal('remote'),
    url: z.url(),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
});

export const McpConfigEntrySchema = z.discriminatedUnion('type', [
    LocalMcpConfigEntrySchema,
    RemoteMcpConfigEntrySchema,
]);
export type McpConfigEntry = z.infer<typeof McpConfigEntrySchema>;
export type LocalMcpConfigEntry = z.infer<typeof LocalMcpConfigEntrySchema>;
export type RemoteMcpConfigEntry = z.infer<typeof RemoteMcpConfigEntrySchema>;

/** Map of server name to its config entry (the `mcp`/`mcpServers` value). */
export const McpConfigSchema = z.record(z.string(), McpConfigEntrySchema);
export type McpConfig = z.infer<typeof McpConfigSchema>;

/**
 * Placeholder config hook for a future Language Server (LSP) stdio transport. A real
 * tsserver/rust-analyzer JSON-RPC client that spawns + syncs a language server is deferred
 * (out of scope for this plan). Today nothing reads this section and nothing wires a client,
 * so the `lsp` tool stays unadvertised by default. The fields mirror the MCP local entry shape
 * so a future transport can be injected with minimal schema churn.
 */
export const LspConfigSchema = z
    .object({
        enabled: z.boolean().optional(),
        command: z.array(z.string()).min(1).optional(),
        environment: z.record(z.string(), z.string()).optional(),
        timeoutMs: z.number().int().positive().optional(),
    })
    .strict();
export type LspConfig = z.infer<typeof LspConfigSchema>;

const BrowserHttpConfigSchema = z
    .object({
        browserURL: z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), {
            message: 'browserURL must use http or https',
        }),
    })
    .strict();

const BrowserWebSocketConfigSchema = z
    .object({
        browserWSEndpoint: z.url().refine((value) => ['ws:', 'wss:'].includes(new URL(value).protocol), {
            message: 'browserWSEndpoint must use ws or wss',
        }),
    })
    .strict();

export const BrowserConfigSchema = z.union([BrowserHttpConfigSchema, BrowserWebSocketConfigSchema]);
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;

export const TeamModeConfigSchema = z
    .object({
        enabled: z.boolean().default(false),
        maxParallelMembers: z.number().int().min(1).max(8).default(4),
        maxMembers: z.number().int().min(1).max(8).default(8),
        messagePayloadMaxBytes: z.number().int().min(1_024).default(32_768),
        recipientUnreadMaxBytes: z.number().int().min(1_024).default(262_144),
    })
    .strict();
export type TeamModeConfig = z.infer<typeof TeamModeConfigSchema>;

export const MonitorToolsConfigSchema = z
    .object({
        enabled: z.boolean().default(false),
        liveModeEnabled: z.boolean().default(false),
        maxMonitorsPerSession: z.number().int().positive().default(3),
        maxRuntimeMs: z.number().int().positive().default(1_800_000),
    })
    .strict();
export type MonitorToolsConfig = z.infer<typeof MonitorToolsConfigSchema>;

export const SshConfigSchema = z
    .object({
        hosts: SshHostsConfigSchema,
    })
    .strict();
export type SshConfig = z.infer<typeof SshConfigSchema>;

export const DebugConfigSchema = z
    .object({
        enabled: z.boolean().default(false),
    })
    .strict();
export type DebugConfig = z.infer<typeof DebugConfigSchema>;

export const SESSION_DEBUG_MIN_BYTES = 32 * 1024 * 1024;
export const SESSION_DEBUG_MAX_BYTES = 1024 * 1024 * 1024;
export const SESSION_DEBUG_DEFAULT_RETENTION_DAYS = 30;
export const SESSION_DEBUG_MAX_RETENTION_DAYS = 365;

/**
 * The isolated `session_debug` user-config domain. It is deliberately not a member
 * of {@link MissionControlConfigSchema}: callers detach it before strict parsing
 * the normal configuration, so diagnostic configuration can never invalidate
 * ordinary MCP/runtime configuration.
 */
export const SessionDebugConfigSchema = z
    .object({
        enabled: z.boolean().default(false),
        maxBytes: z.number().int().min(SESSION_DEBUG_MIN_BYTES).max(SESSION_DEBUG_MAX_BYTES).default(SESSION_DEBUG_MAX_BYTES),
        retentionDays: z
            .number()
            .int()
            .min(1)
            .max(SESSION_DEBUG_MAX_RETENTION_DAYS)
            .default(SESSION_DEBUG_DEFAULT_RETENTION_DAYS),
    })
    .strict();
export type SessionDebugConfig = z.infer<typeof SessionDebugConfigSchema>;

/**
 * The mission-control global `config.json` top-level shape. Only the global/user config defines
 * `mcp_env_allowlist` (omo security rule: walked project `.mcp.json` files cannot extend the
 * allowlist; a project allowlist is ignored by the loader).
 */
export const MissionControlConfigSchema = z
    .object({
        mcp: McpConfigSchema.optional(),
        mcp_env_allowlist: z.array(z.string()).optional(),
        lsp: LspConfigSchema.optional(),
        browser: BrowserConfigSchema.optional(),
        memory: MemoryBackendConfigSchema.optional(),
        team_mode: TeamModeConfigSchema.optional(),
        monitor: MonitorToolsConfigSchema.optional(),
        ssh: SshConfigSchema.optional(),
        debug: DebugConfigSchema.optional(),
    })
    .strict();
export type MissionControlConfig = z.infer<typeof MissionControlConfigSchema>;

/** The Claude-Code-compatible project-local `.mcp.json` shape. */
export const McpProjectConfigSchema = z
    .object({
        mcpServers: McpConfigSchema.optional(),
    })
    .strict();
export type McpProjectConfig = z.infer<typeof McpProjectConfigSchema>;
