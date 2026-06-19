/**
 * `RemoteMcpClient` — a remote MCP client over Streamable HTTP (primary) with an SSE fallback,
 * implementing the `McpClient` seam (`listTools` / `callTool`) declared in `../mcp-tool.ts`. It
 * mirrors `StdioMcpClient`'s hardening contract so both transports are interchangeable from the
 * caller's perspective.
 *
 * Connect strategy (opencode `mcp/index.ts` precedent): try `StreamableHTTPClientTransport`
 * first; on a non-auth failure fall back to `SSEClientTransport`. An HTTP 401/403 surfaces as a
 * clear auth error immediately (no fallback) so a misconfigured token is not masked as a generic
 * transport failure.
 *
 * Hardening (load-bearing — same stance as todo 4):
 * - Bounded deadline on EVERY transport call (`connect` / `listTools` / `callTool`). A hung
 *   endpoint that accepts the connection but never replies would otherwise block the eager
 *   connect at session start (todo 7); the deadline turns that hang into a clean retryable
 *   failure and disconnects so the transport cannot leak.
 * - Secret redaction. The configured header/credential VALUES handed to the remote endpoint are
 *   redacted from tool OUTPUT and ERROR messages before they leave this client, because the repo
 *   AGENTS.md bans raw credentials from events/JSONL/CLI/desktop. A server can echo a header
 *   value in an error; this layer masks it. Arbitrary remote OUTPUT is untrusted DATA, bounded by
 *   the tool's output cap (not scrubbed here).
 * - Idle eviction. After `idleTimeoutMs` (default ~5min, opencode precedent) of no activity the
 *   client disconnects itself; the timer resets on each `listTools` / `callTool`. Pass
 *   `idleTimeoutMs: 0` to disable when an external manager owns the lifecycle (todo 7).
 *
 * v1 auth: headers/bearer only. Full OAuth PKCE + metadata discovery is deferred (follow-up); a
 * headers/bearer path is sufficient for v1.
 *
 * `callTool` returns opaque `unknown`; it is narrowed with `in` / `typeof` (no casts), then
 * deep-redacted structurally so both the model-facing string and the structured event payload
 * stay clean.
 */

import type { ProtocolError } from '@mission-control/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpClient, McpToolInfo } from '../mcp-tool.js';
import { ToolExecutionError } from '../tool-registry-types.js';
import { DEFAULT_MCP_TIMEOUT_MS, McpDeadline, raceWithDeadline } from './deadline.js';
import { createSecretRedactor, type SecretRedactor } from './secret-redaction.js';

const CLIENT_NAME = 'mission-control';
const CLIENT_VERSION = '0.1.0';
/** Idle eviction precedent from opencode (~5min): drop the connection after this long inactive. */
export const DEFAULT_MCP_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** Cap pagination so a server that always returns a cursor cannot loop forever. */
const MAX_TOOL_PAGES = 50;

/**
 * Minimal handle the client drives once connected. The real SDK `Client` satisfies this
 * structurally; tests inject a fake that implements the same surface (so no real network and no
 * JSON-RPC plumbing are required to exercise the deadline / fallback / redaction logic).
 */
export type McpRemoteClientHandle = {
    connect(transport: Transport, options?: RequestOptions): Promise<void>;
    listTools(params?: object, options?: RequestOptions): Promise<unknown>;
    callTool(params: object, resultSchema?: undefined, options?: RequestOptions): Promise<unknown>;
    close(): Promise<void>;
};

/** Factory for a transport candidate (Streamable HTTP or SSE). */
export type RemoteTransportFactory = (url: URL, options?: { readonly requestInit?: RequestInit }) => Transport;

/** Factory for the MCP client handle. */
export type RemoteClientFactory = (info: { readonly name: string; readonly version: string }) => McpRemoteClientHandle;

export type RemoteMcpClientOptions = {
    /** Remote endpoint URL (e.g. `https://host/mcp`). Must parse as a valid URL. */
    readonly url: string;
    /** Optional HTTP headers (auth bearer / custom). Secret values should also be in `secrets`. */
    readonly headers?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
    /** Idle eviction timeout; pass `0` to disable. Defaults to ~5min. */
    readonly idleTimeoutMs?: number;
    /**
     * Secret values injected via `headers` (or other credential fields). Each is redacted from
     * tool output and error messages before they leave this client.
     */
    readonly secrets?: readonly string[];
    readonly clientName?: string;
    readonly clientVersion?: string;
    /** @internal — test seam overriding the Streamable HTTP transport factory. */
    readonly streamableTransportFactory?: RemoteTransportFactory;
    /** @internal — test seam overriding the SSE transport factory. */
    readonly sseTransportFactory?: RemoteTransportFactory;
    /** @internal — test seam overriding the client handle factory. */
    readonly clientFactory?: RemoteClientFactory;
};

type ActiveConnection = {
    readonly kind: 'streamable-http' | 'sse';
    readonly transport: Transport;
    readonly client: McpRemoteClientHandle;
};

export class RemoteMcpClient implements McpClient {
    private readonly parsedUrl: URL;
    private readonly headers: Readonly<Record<string, string>>;
    private readonly timeoutMs: number;
    private readonly idleTimeoutMs: number;
    private readonly clientName: string;
    private readonly clientVersion: string;
    private readonly redactor: SecretRedactor;
    private readonly streamableFactory: RemoteTransportFactory;
    private readonly sseFactory: RemoteTransportFactory;
    private readonly clientFactory: RemoteClientFactory;

    private active: ActiveConnection | undefined;
    private connected = false;
    private closing = false;
    private idleTimerId: ReturnType<typeof setTimeout> | undefined;

    constructor(options: RemoteMcpClientOptions) {
        if (typeof options.url !== 'string' || options.url.length === 0) {
            throw new ToolExecutionError({
                code: 'tool_failed',
                message: 'mcp http connect: missing url',
                retryable: false,
            });
        }
        try {
            this.parsedUrl = new URL(options.url);
        } catch (error) {
            const raw = error instanceof Error ? error.message : String(error);
            throw new ToolExecutionError({
                code: 'tool_failed',
                message: `mcp http connect: invalid url: ${raw}`,
                retryable: false,
            });
        }
        this.headers = options.headers === undefined ? {} : { ...options.headers };
        this.timeoutMs = options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
        this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_MCP_IDLE_TIMEOUT_MS;
        this.clientName = options.clientName ?? CLIENT_NAME;
        this.clientVersion = options.clientVersion ?? CLIENT_VERSION;
        this.redactor = createSecretRedactor(options.secrets ?? []);
        this.streamableFactory = options.streamableTransportFactory ?? defaultStreamableTransport;
        this.sseFactory = options.sseTransportFactory ?? defaultSseTransport;
        this.clientFactory = options.clientFactory ?? defaultClientFactory;
    }

    async connect(): Promise<void> {
        if (this.connected || this.closing) {
            return;
        }
        const requestInit = this.buildRequestInit();
        const streamableTransport = this.streamableFactory(this.parsedUrl, { requestInit });

        try {
            const client = this.clientFactory({ name: this.clientName, version: this.clientVersion });
            await this.withDeadline('mcp http connect', (signal) => client.connect(streamableTransport, { signal }));
            this.adopt('streamable-http', streamableTransport, client);
            return;
        } catch (streamableError) {
            await this.safeCloseTransport(streamableTransport);
            if (isAuthError(streamableError)) {
                throw this.toAuthError(streamableError, 'mcp http connect');
            }
            // Non-auth streamable failure: fall through to the SSE candidate.
        }

        const sseTransport = this.sseFactory(this.parsedUrl, { requestInit });
        try {
            const client = this.clientFactory({ name: this.clientName, version: this.clientVersion });
            await this.withDeadline('mcp sse connect', (signal) => client.connect(sseTransport, { signal }));
            this.adopt('sse', sseTransport, client);
        } catch (sseError) {
            await this.safeCloseTransport(sseTransport);
            if (isAuthError(sseError)) {
                throw this.toAuthError(sseError, 'mcp sse connect');
            }
            throw this.toToolError(sseError, 'mcp connect');
        }
    }

    async listTools(): Promise<readonly McpToolInfo[]> {
        await this.ensureConnected();
        const active = this.active;
        if (active === undefined) {
            throw this.toToolError(new Error('mcp client not connected'), 'listTools');
        }
        try {
            return await this.withDeadline('mcp listTools', async (signal) => {
                const collected: McpToolInfo[] = [];
                let cursor: string | undefined;
                for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
                    const params = cursor === undefined ? {} : { cursor };
                    const result = await active.client.listTools(params, { signal });
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
        } finally {
            this.resetIdleTimer();
        }
    }

    async callTool(request: { readonly name: string; readonly arguments?: unknown }): Promise<unknown> {
        await this.ensureConnected();
        const active = this.active;
        if (active === undefined) {
            throw this.toToolError(new Error('mcp client not connected'), `callTool "${request.name}"`);
        }
        try {
            return await this.withDeadline('mcp callTool', async (signal) => {
                const args = isRecord(request.arguments) ? { arguments: request.arguments } : {};
                const params = { name: request.name, ...args };
                const result = await active.client.callTool(params, undefined, { signal });
                return this.redactor.redactValue(result);
            });
        } catch (error) {
            throw this.toToolError(error, `callTool "${request.name}"`);
        } finally {
            this.resetIdleTimer();
        }
    }

    async close(): Promise<void> {
        if (this.closing) {
            return;
        }
        this.closing = true;
        this.clearIdleTimer();
        await this.forceTeardown();
    }

    private adopt(kind: 'streamable-http' | 'sse', transport: Transport, client: McpRemoteClientHandle): void {
        this.active = { kind, transport, client };
        this.connected = true;
        this.resetIdleTimer();
    }

    private async ensureConnected(): Promise<void> {
        if (this.connected && this.active !== undefined) {
            return;
        }
        throw this.toToolError(new Error('mcp client is not connected'), 'ensureConnected');
    }

    /**
     * Race a transport call against the deadline. On expiry disconnect and wrap into a retryable
     * `ToolExecutionError`. Mirrors `StdioMcpClient.withDeadline` over the shared helper.
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

    private buildRequestInit(): RequestInit {
        const headerEntries = Object.entries(this.headers);
        if (headerEntries.length === 0) {
            return {};
        }
        const headers = new Headers();
        for (const [key, value] of headerEntries) {
            headers.set(key, value);
        }
        return { headers };
    }

    private resetIdleTimer(): void {
        this.clearIdleTimer();
        if (this.idleTimeoutMs <= 0 || this.closing) {
            return;
        }
        this.idleTimerId = setTimeout(() => {
            this.idleTimerId = undefined;
            void this.close();
        }, this.idleTimeoutMs);
    }

    private clearIdleTimer(): void {
        if (this.idleTimerId !== undefined) {
            clearTimeout(this.idleTimerId);
            this.idleTimerId = undefined;
        }
    }

    private async forceTeardown(): Promise<void> {
        this.connected = false;
        const active = this.active;
        this.active = undefined;
        if (active !== undefined) {
            try {
                await active.client.close();
            } catch {
                // best-effort: the endpoint may already have gone away
            }
            await this.safeCloseTransport(active.transport);
        }
    }

    private async safeCloseTransport(transport: Transport): Promise<void> {
        try {
            await transport.close();
        } catch {
            // best-effort
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

    private toAuthError(error: unknown, label: string): ToolExecutionError {
        const raw = error instanceof Error ? error.message : String(error);
        const protocolError: ProtocolError = {
            code: 'tool_failed',
            message: this.redactor.redactText(`${label}: authentication failed (${raw})`),
            retryable: false,
        };
        return new ToolExecutionError(protocolError);
    }
}

function defaultStreamableTransport(url: URL, options?: { readonly requestInit?: RequestInit }): Transport {
    const requestInit = options?.requestInit;
    const transport = new StreamableHTTPClientTransport(url, requestInit === undefined ? {} : { requestInit });
    // Upstream SDK defect: its `sessionId` getter returns `string | undefined` but `Transport`
    // declares `sessionId?: string`; under `exactOptionalPropertyTypes` the concrete class fails its
    // own interface check. This cast to the SDK's declared interface is the minimal escape.
    return transport as Transport;
}

function defaultSseTransport(url: URL, options?: { readonly requestInit?: RequestInit }): Transport {
    const requestInit = options?.requestInit;
    return new SSEClientTransport(url, requestInit === undefined ? {} : { requestInit });
}

function defaultClientFactory(info: { readonly name: string; readonly version: string }): McpRemoteClientHandle {
    return new Client({ name: info.name, version: info.version }, {});
}

/**
 * Detect an HTTP 401/403 (auth) failure so it surfaces immediately instead of falling back to
 * SSE. The SDK throws `StreamableHTTPError` / `SseError` with a numeric `code`, but after the
 * client wraps it the shape may be a plain `Error`; check both the structural `code` field and
 * the message text.
 */
function isAuthError(error: unknown): boolean {
    const code = readErrorCode(error);
    if (code === 401 || code === 403) {
        return true;
    }
    if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (
            message.includes('401') ||
            message.includes('403') ||
            message.includes('unauthorized') ||
            message.includes('forbidden')
        ) {
            return true;
        }
    }
    return false;
}

function readErrorCode(error: unknown): number | undefined {
    if (!isRecord(error)) {
        return undefined;
    }
    const code = error['code'];
    return typeof code === 'number' ? code : undefined;
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
