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

import { createObservabilityRedactor, type ObservabilityRedactor } from '../../providers/observability-redactor.js';
import type { ProjectTrustDecision } from '../../trust/project-trust-store.js';
import type { McpToolInfo } from '../mcp-tool.js';
import { loadRuntimeMcpConfig, type McpConfigScope, type ResolvedMcpServer } from './config.js';
import { McpConnectionLifecycle } from './connection-lifecycle.js';
import { createDefaultMcpClient } from './default-client.js';

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
    readonly scope: McpConfigScope;
    readonly client: ManagedMcpClient;
    readonly tools: readonly McpToolInfo[];
};

export type McpConnectionManagerOptions = {
    readonly workspaceRoot: string;
    readonly projectTrustDecision: ProjectTrustDecision;
    readonly userConfigPath?: string;
    readonly projectConfigPath?: string;
    readonly profileName?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
};

export type McpConnectionManagerDependencies = {
    readonly clientFactory?: (server: ResolvedMcpServer, secrets: readonly string[]) => ManagedMcpClient;
};

/**
 * Session-scoped connection manager. Owns `McpClient` instances and their child processes.
 * Call `connectAll()` at session start, then `disconnectAll()` on teardown. Repeated calls are idempotent.
 */
export class McpConnectionManager {
    private readonly servers: ConnectedMcpServer[] = [];
    private readonly warnings: string[] = [];
    private observabilityRedactor = createObservabilityRedactor();
    private readonly lifecycle = new McpConnectionLifecycle();
    private readonly clientFactory:
        | ((server: ResolvedMcpServer, secrets: readonly string[]) => ManagedMcpClient)
        | undefined;

    constructor(dependencies: McpConnectionManagerDependencies = {}) {
        this.clientFactory = dependencies.clientFactory;
    }

    /**
     * Connect to all enabled MCP servers, list their tools, and cache the results.
     * On a per-server failure (crash OR hang/deadline), emit a warning and skip that
     * server — the session continues with the remaining servers' tools.
     */
    connectAll(options: McpConnectionManagerOptions): Promise<void> {
        return this.lifecycle.connect(() => this.connectAllOnce(options));
    }

    private async connectAllOnce(configOptions: McpConnectionManagerOptions): Promise<void> {
        const config = await loadRuntimeMcpConfig(configOptions);
        this.observabilityRedactor = createObservabilityRedactor({ secrets: config.expandedSecrets });
        for (const error of config.errors) {
            this.warnings.push(this.observabilityRedactor.redactText(`mcp config: ${error.source}: ${error.message}`));
        }
        let totalTools = 0;
        for (const server of config.servers) {
            if (!server.enabled || this.lifecycle.isClosed() || this.lifecycle.isScopeQuarantined(server.scope)) {
                continue;
            }
            if (totalTools >= MAX_TOTAL_NAMESPACED_TOOLS) {
                this.warnings.push(`mcp: reached tool cap (${MAX_TOTAL_NAMESPACED_TOOLS}), skipping remaining servers`);
                break;
            }
            const connected = await this.connectServer(server, config.expandedSecrets, configOptions.workspaceRoot);
            if (connected === undefined) {
                continue;
            }
            if (this.lifecycle.isClosed() || this.lifecycle.isScopeQuarantined(server.scope)) {
                await connected.client.close().catch(() => undefined);
                continue;
            }
            const toolsToRegister = Math.min(connected.tools.length, MAX_TOTAL_NAMESPACED_TOOLS - totalTools);
            if (toolsToRegister < connected.tools.length) {
                this.warnings.push(
                    this.observabilityRedactor.redactText(
                        `mcp server "${server.name}": ${connected.tools.length} tools exceed cap, registering first ${toolsToRegister}`,
                    ),
                );
            }
            this.servers.push(this.observableServer(server, connected, toolsToRegister));
            totalTools += toolsToRegister;
        }
    }

    /** Tear down all MCP server connections. Safe to call multiple times. */
    disconnectAll(): Promise<void> {
        return this.lifecycle.disconnectAll(() => this.disconnectAllOwned());
    }

    private async disconnectAllOwned(): Promise<void> {
        const disconnected = this.servers.splice(0);
        await closeServers(disconnected);
    }

    disconnectScope(scope: McpConfigScope): Promise<void> {
        return this.lifecycle.disconnectScope(scope, () => this.disconnectScopeOwned(scope));
    }

    private async disconnectScopeOwned(scope: McpConfigScope): Promise<void> {
        const disconnected = this.servers.filter((server) => server.scope === scope);
        const retained = this.servers.filter((server) => server.scope !== scope);
        this.servers.length = 0;
        this.servers.push(...retained);
        await closeServers(disconnected);
    }

    /** Connected servers and their listed tools. Empty before `connectAll()`. */
    getServers(): readonly ConnectedMcpServer[] {
        return this.servers;
    }

    /** Warnings accumulated during `connectAll()` (config errors, server failures). */
    getWarnings(): readonly string[] {
        return this.warnings;
    }

    getObservabilityRedactor(): ObservabilityRedactor {
        return this.observabilityRedactor;
    }

    private observableServer(
        server: ResolvedMcpServer,
        connected: { readonly client: ManagedMcpClient; readonly tools: readonly McpToolInfo[] },
        toolsToRegister: number,
    ): ConnectedMcpServer {
        const executionNames = new Map<string, string>();
        const usedNames = new Set<string>();
        const tools = connected.tools.slice(0, toolsToRegister).map((tool) => {
            const redactedName = this.observabilityRedactor.redactText(tool.name) || 'tool';
            const name = uniqueObservableName(redactedName, usedNames);
            usedNames.add(name);
            executionNames.set(name, tool.name);
            return {
                name,
                ...(tool.description !== undefined
                    ? { description: this.observabilityRedactor.redactText(tool.description) }
                    : {}),
                ...(tool.inputSchema !== undefined
                    ? { inputSchema: this.observabilityRedactor.redactValue(tool.inputSchema) }
                    : {}),
            };
        });
        let active = true;
        let closePromise: Promise<void> | undefined;
        const client: ManagedMcpClient = {
            connect: () => connected.client.connect(),
            listTools: async () => tools,
            callTool: (input) =>
                active
                    ? connected.client.callTool({
                          ...input,
                          name: executionNames.get(input.name) ?? input.name,
                      })
                    : Promise.reject(new McpConnectionClosedError()),
            close: () => {
                if (closePromise !== undefined) {
                    return closePromise;
                }
                active = false;
                closePromise = connected.client.close();
                return closePromise;
            },
        };
        return {
            name: this.observabilityRedactor.redactText(server.name) || 'server',
            scope: server.scope,
            client,
            tools,
        };
    }

    private async connectServer(
        server: ResolvedMcpServer,
        expandedSecrets: readonly string[],
        workspaceRoot: string,
    ): Promise<{ readonly client: ManagedMcpClient; readonly tools: readonly McpToolInfo[] } | undefined> {
        let client: ManagedMcpClient | undefined;
        try {
            client =
                this.clientFactory === undefined
                    ? createDefaultMcpClient(server, expandedSecrets, workspaceRoot)
                    : this.clientFactory(server, expandedSecrets);
            await client.connect();
            const tools = await client.listTools();
            return { client, tools };
        } catch (error: unknown) {
            await client?.close().catch(() => undefined);
            const message = error instanceof Error ? error.message : String(error);
            this.warnings.push(
                this.observabilityRedactor.redactText(`mcp server "${server.name}": failed to connect — ${message}`),
            );
            return undefined;
        }
    }
}

class McpConnectionClosedError extends Error {
    readonly name = 'McpConnectionClosedError';

    constructor() {
        super('MCP connection is closed');
    }
}

async function closeServers(servers: readonly ConnectedMcpServer[]): Promise<void> {
    await Promise.all(servers.map((server) => server.client.close().catch(() => undefined)));
}

function uniqueObservableName(base: string, used: ReadonlySet<string>): string {
    if (!used.has(base)) {
        return base;
    }
    let suffix = 2;
    while (used.has(`${base}_${suffix}`)) {
        suffix += 1;
    }
    return `${base}_${suffix}`;
}
