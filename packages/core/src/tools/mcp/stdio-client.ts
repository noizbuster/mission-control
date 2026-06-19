/**
 * `StdioMcpClient` — a real MCP stdio client over `@modelcontextprotocol/sdk`, implementing the
 * `McpClient` seam (`listTools` / `callTool`) declared in `../mcp-tool.ts`. It spawns the
 * configured server command over stdin/stdout, speaks the MCP initialize handshake, lists and
 * invokes tools, and tears the child down on `close()`.
 *
 * Hardening (load-bearing):
 * - Bounded deadline on EVERY transport call (`connect` / `listTools` / `callTool`). A hung
 *   server that accepts the connection but never replies would otherwise block the eager connect
 *   at session start (todo 7); the deadline turns that hang into a clean retryable failure and
 *   tears the child down so it cannot leak.
 * - Secret redaction. The expanded `environment` secret values handed to the spawned server are
 *   redacted from tool OUTPUT and ERROR messages before they leave this client, because the repo
 *   AGENTS.md bans raw credentials from events/JSONL/CLI/desktop. A server can echo an injected
 *   env value in an error; this layer masks it. Unrelated server output is untrusted DATA, bounded
 *   by the tool's output cap (not scrubbed here).
 *
 * `callTool` returns opaque `unknown`; it is narrowed with `in` / `typeof` (no casts), then
 * deep-redacted structurally so both the model-facing string and the structured event payload
 * stay clean.
 */

import type { ProtocolError } from '@mission-control/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpClient, McpToolInfo } from '../mcp-tool.js';
import { ToolExecutionError } from '../tool-registry-types.js';
import { DEFAULT_MCP_TIMEOUT_MS, McpDeadline, raceWithDeadline } from './deadline.js';
import { createSecretRedactor, type SecretRedactor } from './secret-redaction.js';

const CLIENT_NAME = 'mission-control';
const CLIENT_VERSION = '0.1.0';
/** Cap pagination so a server that always returns a cursor cannot loop forever. */
const MAX_TOOL_PAGES = 50;

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

export class StdioMcpClient implements McpClient {
    private readonly command: string;
    private readonly args: readonly string[];
    private readonly env: Readonly<Record<string, string>>;
    private readonly cwd: string;
    private readonly timeoutMs: number;
    private readonly clientName: string;
    private readonly clientVersion: string;
    private readonly redactor: SecretRedactor;

    private transport: StdioClientTransport | undefined;
    private client: Client | undefined;
    private connected = false;
    private closing = false;

    constructor(options: StdioMcpClientOptions) {
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

    async listTools(): Promise<readonly McpToolInfo[]> {
        await this.ensureConnected();
        const client = this.client;
        if (client === undefined) {
            throw this.toToolError(new Error('mcp client not connected'), 'listTools');
        }
        try {
            return await this.withDeadline('mcp listTools', async (signal) => {
                const collected: McpToolInfo[] = [];
                let cursor: string | undefined;
                for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
                    const params = cursor === undefined ? {} : { cursor };
                    const result = await client.listTools(params, { signal });
                    const tools = readToolsField(result);
                    for (const tool of tools) {
                        const adapted = adaptTool(tool);
                        if (adapted !== undefined) {
                            collected.push(adapted);
                        }
                    }
                    const next = readNextCursor(result);
                    if (next === undefined) {
                        break;
                    }
                    cursor = next;
                }
                return collected;
            });
        } catch (error) {
            throw this.toToolError(error, 'listTools');
        }
    }

    async callTool(request: { readonly name: string; readonly arguments?: unknown }): Promise<unknown> {
        await this.ensureConnected();
        const client = this.client;
        if (client === undefined) {
            throw this.toToolError(new Error('mcp client not connected'), `callTool "${request.name}"`);
        }
        try {
            return await this.withDeadline('mcp callTool', async (signal) => {
                const args = isRecord(request.arguments) ? { arguments: request.arguments } : {};
                const params = { name: request.name, ...args };
                const result = await client.callTool(params, undefined, { signal });
                return this.redactor.redactValue(result);
            });
        } catch (error) {
            throw this.toToolError(error, `callTool "${request.name}"`);
        }
    }

    async close(): Promise<void> {
        if (this.closing) {
            return;
        }
        this.closing = true;
        await this.forceTeardown();
    }

    private async ensureConnected(): Promise<void> {
        if (this.connected && this.client !== undefined) {
            return;
        }
        throw this.toToolError(new Error('mcp client is not connected'), 'ensureConnected');
    }

    /**
     * Race a transport call against the deadline. The abort signal is forwarded to the SDK so it
     * can cancel the in-flight request promptly; the race is the backstop so a server that
     * swallows the abort still surfaces at the deadline. On expiry the child is torn down and the
     * deadline is wrapped into a retryable `ToolExecutionError`.
     */
    private async withDeadline<T>(label: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
        try {
            return await raceWithDeadline(label, this.timeoutMs, run);
        } catch (error) {
            if (error instanceof McpDeadline) {
                await this.forceTeardown();
                throw this.toToolError(error, label);
            }
            throw error;
        }
    }

    private async forceTeardown(): Promise<void> {
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

    private toToolError(error: unknown, label: string): ToolExecutionError {
        const raw = error instanceof Error ? error.message : String(error);
        const protocolError: ProtocolError = {
            code: 'tool_failed',
            message: this.redactor.redactText(`${label}: ${raw}`),
            retryable: true,
        };
        return new ToolExecutionError(protocolError);
    }
}

/**
 * Read the `tools` array off a `listTools` result. The SDK return carries an index signature, so
 * the field is read by bracket access and narrowed structurally (no casts).
 */
function readToolsField(result: unknown): readonly unknown[] {
    if (!isRecord(result)) {
        return [];
    }
    const tools = result['tools'];
    if (!Array.isArray(tools)) {
        return [];
    }
    return tools;
}

function readNextCursor(result: unknown): string | undefined {
    if (!isRecord(result)) {
        return undefined;
    }
    const cursor = result['nextCursor'];
    return typeof cursor === 'string' && cursor.length > 0 ? cursor : undefined;
}

function adaptTool(tool: unknown): McpToolInfo | undefined {
    if (!isRecord(tool)) {
        return undefined;
    }
    const name = tool['name'];
    if (typeof name !== 'string' || name.length === 0) {
        return undefined;
    }
    const description = tool['description'];
    const inputSchema = tool['inputSchema'];
    return {
        name,
        ...(typeof description === 'string' ? { description } : {}),
        ...(isRecord(inputSchema) ? { inputSchema } : {}),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
