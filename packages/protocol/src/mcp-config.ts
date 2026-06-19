import { z } from 'zod';

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
    url: z.string().url(),
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
