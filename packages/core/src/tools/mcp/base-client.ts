/**
 * Shared base for the real MCP clients (`StdioMcpClient`, `RemoteMcpClient`). Both transports
 * drive an MCP `Client` handle the same way once connected: a bounded pagination loop over
 * `listTools`, a `callTool` body that forwards arguments + redacts the result, a deadline race
 * around every transport call, and secret-redacting error wrapping. That shared logic lives
 * here; subclasses own ONLY the transport-specific lifecycle — `connect`, `forceTeardown`, and
 * (for the remote client) idle eviction + auth fallback.
 *
 * The subclass exposes its connected client handle via `getClient()` (returning `undefined`
 * while disconnected) and tears transport resources down via `forceTeardown()`. The deadline
 * helper (`raceWithDeadline`) is transport-agnostic on purpose so both clients share it.
 */

import type { ProtocolError } from '@mission-control/protocol';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { McpClient, McpToolInfo } from '../mcp-tool';
import { ToolExecutionError } from '../tool-registry-types';
import { McpDeadline, raceWithDeadline } from './deadline';
import type { SecretRedactor } from './secret-redaction';

export const CLIENT_NAME = 'mission-control';
export const CLIENT_VERSION = '0.1.0';
/** Cap pagination so a server that always returns a cursor cannot loop forever. */
export const MAX_TOOL_PAGES = 50;

/**
 * Minimal handle the base client drives once connected. The real SDK `Client` satisfies this
 * structurally; the remote client's `McpRemoteClientHandle` and test fakes implement the same
 * surface (so no real transport is required to exercise the deadline / redaction logic).
 * `connect`/`close` are intentionally omitted — teardown is transport-specific.
 */
export type McpClientHandle = {
    listTools(params?: object, options?: RequestOptions): Promise<unknown>;
    callTool(params: object, resultSchema?: undefined, options?: RequestOptions): Promise<unknown>;
};

export abstract class BaseMcpClient implements McpClient {
    /** Set `true` once the transport handshake completes; cleared by `forceTeardown`. */
    protected connected = false;
    /** Latches on `close()` so re-entrant / concurrent closes collapse to one teardown. */
    protected closing = false;

    protected abstract readonly redactor: SecretRedactor;
    protected abstract readonly timeoutMs: number;

    /** The connected client handle, or `undefined` when not connected. */
    protected abstract getClient(): McpClientHandle | undefined;

    /** Tear down transport-specific resources (child process / HTTP transport). */
    protected abstract forceTeardown(): Promise<void>;

    /**
     * Hook invoked after every `listTools`/`callTool` settles (success or error). The base
     * implementation is a no-op; `RemoteMcpClient` overrides it to reset its idle-eviction
     * timer so activity postpones the connection drop.
     */
    protected afterActivity(): void {}

    async listTools(): Promise<readonly McpToolInfo[]> {
        await this.ensureConnected();
        const client = this.getClient();
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
        } finally {
            this.afterActivity();
        }
    }

    async callTool(request: { readonly name: string; readonly arguments?: unknown }): Promise<unknown> {
        await this.ensureConnected();
        const client = this.getClient();
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
        } finally {
            this.afterActivity();
        }
    }

    protected async ensureConnected(): Promise<void> {
        if (this.getClient() !== undefined) {
            return;
        }
        throw this.toToolError(new Error('mcp client is not connected'), 'ensureConnected');
    }

    /**
     * Race a transport call against the deadline. The abort signal is forwarded to the SDK so it
     * can cancel the in-flight request promptly; the race is the backstop so a server that
     * swallows the abort still surfaces at the deadline. On expiry the transport is torn down and
     * the deadline is wrapped into a retryable `ToolExecutionError`.
     */
    protected async withDeadline<T>(label: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
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

    protected toToolError(error: unknown, label: string): ToolExecutionError {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
