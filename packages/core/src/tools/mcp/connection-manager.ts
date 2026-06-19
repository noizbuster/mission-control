/**
 * `McpConnectionManager` — session-scoped lifecycle owner for MCP server connections.
 *
 * Connects to all enabled MCP servers from the resolved config (todo 6 loader),
 * lists their tools, and exposes the results for registration into the coding-agent
 * `ToolRegistry` as namespaced `mcp__<server>__<tool>` entries (todo 7 surfacing).
 *
 * Hardening (load-bearing):
 * - Graceful degradation. If a server crashes OR hangs (the per-call deadline in
 *   `StdioMcpClient` / `RemoteMcpClient` turns a hang into a clean
 *   `ToolExecutionError`), the manager emits a warning and continues WITHOUT that
 *   server's tools. A single failing server MUST NOT fail the whole session.
 * - Bounded tool count. The total number of namespaced tools is capped at
 *   `MAX_TOTAL_NAMESPACED_TOOLS` (50) so the model's context window is not exhausted.
 *   When the cap is reached, remaining servers' tools are skipped.
 * - Closable seam. `disconnectAll()` tears down every client (closing stdio child
 *   processes or HTTP connections) so no MCP server leaks on `stop()`.
 */

import type { McpToolInfo } from '../mcp-tool.js';
import { loadResolvedMcpConfig, type ResolvedMcpServer } from './config.js';
import { RemoteMcpClient } from './http-client.js';
import { StdioMcpClient } from './stdio-client.js';

/** Cap total namespaced MCP tools so the model context is not exhausted. */
const MAX_TOTAL_NAMESPACED_TOOLS = 50;

/** A connected MCP client with lifecycle methods. */
export type ManagedMcpClient = {
    connect(): Promise<void>;
    listTools(): Promise<readonly McpToolInfo[]>;
    callTool(input: { readonly name: string; readonly arguments?: unknown }): Promise<unknown>;
    close(): Promise<void>;
};

export type ConnectedMcpServer = {
    readonly name: string;
    readonly client: ManagedMcpClient;
    readonly tools: readonly McpToolInfo[];
};

export type McpConnectionManagerOptions = {
    readonly workspaceRoot: string;
    readonly userConfigPath?: string;
    readonly projectConfigPath?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
};

/**
 * Session-scoped connection manager. Owns `McpClient` instances and their child processes.
 * Call `connectAll()` once at session start, then `disconnectAll()` on teardown.
 */
export class McpConnectionManager {
    private readonly servers: ConnectedMcpServer[] = [];
    private readonly warnings: string[] = [];
    private closed = false;

    /**
     * Connect to all enabled MCP servers, list their tools, and cache the results.
     * On a per-server failure (crash OR hang/deadline), emit a warning and skip that
     * server — the session continues with the remaining servers' tools.
     */
    async connectAll(options?: McpConnectionManagerOptions): Promise<void> {
        if (this.closed) {
            return;
        }
        const configOptions: McpConnectionManagerOptions = options ?? { workspaceRoot: process.cwd() };
        const config = await loadResolvedMcpConfig(configOptions);
        for (const error of config.errors) {
            this.warnings.push(`mcp config: ${error.source}: ${error.message}`);
        }
        let totalTools = 0;
        for (const server of config.servers) {
            if (!server.enabled) {
                continue;
            }
            if (totalTools >= MAX_TOTAL_NAMESPACED_TOOLS) {
                this.warnings.push(`mcp: reached tool cap (${MAX_TOTAL_NAMESPACED_TOOLS}), skipping remaining servers`);
                break;
            }
            const connected = await this.connectServer(server, config.expandedSecrets);
            if (connected === undefined) {
                continue;
            }
            const toolsToRegister = Math.min(connected.tools.length, MAX_TOTAL_NAMESPACED_TOOLS - totalTools);
            if (toolsToRegister < connected.tools.length) {
                this.warnings.push(
                    `mcp server "${server.name}": ${connected.tools.length} tools exceed cap, registering first ${toolsToRegister}`,
                );
            }
            this.servers.push({
                name: server.name,
                client: connected.client,
                tools: connected.tools.slice(0, toolsToRegister),
            });
            totalTools += toolsToRegister;
        }
    }

    /** Tear down all MCP server connections. Safe to call multiple times. */
    async disconnectAll(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.closed = true;
        const disconnects = this.servers.map((server) =>
            server.client.close().catch(() => {
                // best-effort: the server may already be dead
            }),
        );
        await Promise.all(disconnects);
        this.servers.length = 0;
    }

    /** Connected servers and their listed tools. Empty before `connectAll()`. */
    getServers(): readonly ConnectedMcpServer[] {
        return this.servers;
    }

    /** Warnings accumulated during `connectAll()` (config errors, server failures). */
    getWarnings(): readonly string[] {
        return this.warnings;
    }

    private async connectServer(
        server: ResolvedMcpServer,
        expandedSecrets: readonly string[],
    ): Promise<{ readonly client: ManagedMcpClient; readonly tools: readonly McpToolInfo[] } | undefined> {
        try {
            const client = this.createClient(server, expandedSecrets);
            await client.connect();
            const tools = await client.listTools();
            return { client, tools };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this.warnings.push(`mcp server "${server.name}": failed to connect — ${message}`);
            return undefined;
        }
    }

    private createClient(server: ResolvedMcpServer, secrets: readonly string[]): ManagedMcpClient {
        if (server.type === 'local') {
            const args = server.command.length > 1 ? server.command.slice(1) : undefined;
            return new StdioMcpClient({
                command: server.command[0] ?? '',
                ...(args !== undefined ? { args } : {}),
                ...(server.environment !== undefined ? { env: server.environment } : {}),
                cwd: process.cwd(),
                ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
                secrets,
            });
        }
        return new RemoteMcpClient({
            url: server.url,
            ...(server.headers !== undefined ? { headers: server.headers } : {}),
            ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
            secrets,
        });
    }
}
