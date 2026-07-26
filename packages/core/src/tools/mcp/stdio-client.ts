/**
 * `StdioMcpClient` — a real MCP stdio client over `@modelcontextprotocol/sdk`, implementing the
 * `McpClient` seam via `BaseMcpClient`. It spawns the configured server command over
 * stdin/stdout, speaks the MCP initialize handshake, lists and invokes tools, and tears the
 * child down on `close()`. The shared `listTools`/`callTool` pagination + invocation body, the
 * deadline race, and secret-redacting error wrapping all live in `BaseMcpClient`; this class
 * owns only the stdio transport: `connect`, `forceTeardown`, and the `StdioClientTransport` /
 * SDK `Client` lifecycle.
 *
 * Hardening (load-bearing, inherited): every transport call is bounded by a deadline so a hung
 * server rejects at the boundary instead of blocking the eager connect at session start; and the
 * expanded `environment` secret values handed to the spawned server are redacted from tool OUTPUT
 * and ERROR messages before they leave this client, because the repo AGENTS.md bans raw
 * credentials from events/JSONL/CLI/desktop. Unrelated server output is untrusted DATA, bounded
 * by the tool's output cap (not scrubbed here).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BaseMcpClient, CLIENT_NAME, CLIENT_VERSION, type McpClientHandle } from './base-client';
import { DEFAULT_MCP_TIMEOUT_MS } from './deadline';
import { createSecretRedactor, type SecretRedactor } from './secret-redaction';

export type StdioMcpClientOptions = {
    readonly command: string;
    readonly args?: readonly string[];
    /**
     * Environment variables passed to the spawned server. The VALUES that are secrets must also be
     * listed in `secrets` so they get redacted from output/errors. Never pass an unbounded env.
     */
    readonly env?: Readonly<Record<string, string>>;
    /** Working directory the server is spawned in (the workspace root). */
    readonly cwd: string;
    readonly timeoutMs?: number;
    /**
     * Secret values injected via `env` (or headers, for the remote client). Each is redacted from
     * tool output and error messages before they leave this client.
     */
    readonly secrets?: readonly string[];
    readonly clientName?: string;
    readonly clientVersion?: string;
};

export class StdioMcpClient extends BaseMcpClient {
    private readonly command: string;
    private readonly args: readonly string[];
    private readonly env: Readonly<Record<string, string>>;
    private readonly cwd: string;
    protected readonly timeoutMs: number;
    private readonly clientName: string;
    private readonly clientVersion: string;
    protected readonly redactor: SecretRedactor;

    private transport: StdioClientTransport | undefined;
    private client: Client | undefined;

    constructor(options: StdioMcpClientOptions) {
        super();
        this.command = options.command;
        this.args = options.args === undefined ? [] : [...options.args];
        this.env = options.env === undefined ? {} : { ...options.env };
        this.cwd = options.cwd;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
        this.clientName = options.clientName ?? CLIENT_NAME;
        this.clientVersion = options.clientVersion ?? CLIENT_VERSION;
        this.redactor = createSecretRedactor(options.secrets ?? []);
    }

    async connect(): Promise<void> {
        if (this.connected || this.closing) {
            return;
        }
        const transport = new StdioClientTransport({
            command: this.command,
            ...(this.args.length > 0 ? { args: [...this.args] } : {}),
            ...(Object.keys(this.env).length > 0 ? { env: { ...this.env } } : {}),
            cwd: this.cwd,
            stderr: 'pipe',
        });
        const client = new Client({ name: this.clientName, version: this.clientVersion }, {});
        this.transport = transport;
        this.client = client;
        try {
            await this.withDeadline('mcp connect', (signal) => client.connect(transport, { signal }));
            this.connected = true;
        } catch (error) {
            await this.forceTeardown();
            throw this.toToolError(error, 'connect');
        }
    }

    protected getClient(): McpClientHandle | undefined {
        return this.connected ? this.client : undefined;
    }

    protected async forceTeardown(): Promise<void> {
        this.connected = false;
        const transport = this.transport;
        const client = this.client;
        this.transport = undefined;
        this.client = undefined;
        if (client !== undefined) {
            try {
                await client.close();
            } catch {
                // best-effort: the child may already be dead
            }
        }
        if (transport !== undefined) {
            try {
                await transport.close();
            } catch {
                // best-effort
            }
        }
    }

    async close(): Promise<void> {
        if (this.closing) {
            return;
        }
        this.closing = true;
        await this.forceTeardown();
    }
}
