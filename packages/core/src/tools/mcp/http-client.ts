/**
 * `RemoteMcpClient` — a remote MCP client over Streamable HTTP (primary) with an SSE fallback,
 * implementing the `McpClient` seam via `BaseMcpClient`. It speaks the MCP initialize handshake
 * against a remote endpoint, lists and invokes tools, and tears the connection down on `close()`
 * (also after an idle timeout). The shared `listTools`/`callTool` pagination + invocation body,
 * the deadline race, and secret-redacting error wrapping all live in `BaseMcpClient`; this class
 * owns only the remote transport: Streamable-HTTP→SSE `connect` with auth-error short-circuit,
 * idle-eviction timer, transport/transport-factory seams, and the `forceTeardown` shape.
 *
 * Hardening (load-bearing, inherited): every transport call is bounded by a deadline so a hung
 * endpoint rejects at the boundary; and configured header/credential secrets are redacted from
 * tool output and error messages before they leave this client. Remote server output is
 * untrusted DATA, bounded by the tool's output cap (not scrubbed here).
 */

import type { ProtocolError } from '@mission-control/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { BaseMcpClient, CLIENT_NAME, CLIENT_VERSION, isRecord, type McpClientHandle } from './base-client';
import { DEFAULT_MCP_TIMEOUT_MS } from './deadline';
import { createSecretRedactor, type SecretRedactor } from './secret-redaction';
import { ToolExecutionError } from '../tool-registry-types';

/** Idle eviction precedent from opencode (~5min): drop the connection after this long inactive. */
export const DEFAULT_MCP_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

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

export class RemoteMcpClient extends BaseMcpClient {
    private readonly parsedUrl: URL;
    private readonly headers: Readonly<Record<string, string>>;
    protected readonly timeoutMs: number;
    private readonly idleTimeoutMs: number;
    private readonly clientName: string;
    private readonly clientVersion: string;
    protected readonly redactor: SecretRedactor;
    private readonly streamableFactory: RemoteTransportFactory;
    private readonly sseFactory: RemoteTransportFactory;
    private readonly clientFactory: RemoteClientFactory;

    private active: ActiveConnection | undefined;
    private idleTimerId: ReturnType<typeof setTimeout> | undefined;

    constructor(options: RemoteMcpClientOptions) {
        super();
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

    async close(): Promise<void> {
        if (this.closing) {
            return;
        }
        this.closing = true;
        this.clearIdleTimer();
        await this.forceTeardown();
    }

    protected getClient(): McpClientHandle | undefined {
        return this.connected && this.active !== undefined ? this.active.client : undefined;
    }

    protected afterActivity(): void {
        this.resetIdleTimer();
    }

    private adopt(kind: 'streamable-http' | 'sse', transport: Transport, client: McpRemoteClientHandle): void {
        this.active = { kind, transport, client };
        this.connected = true;
        this.resetIdleTimer();
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

    protected async forceTeardown(): Promise<void> {
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
