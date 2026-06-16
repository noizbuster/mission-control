/**
 * `mcp` tool — bridge to a Model Context Protocol server's tools (Phase 4 deferred item).
 *
 * MCP servers expose a dynamic set of tools; this tool bridges ONE such server: the agent
 * calls `mcp` with a `tool` name + `arguments`, and the tool delegates to an injected
 * `McpClient`. The client seam (`listTools` / `callTool`) is where real transport lives — a
 * stdio JSON-RPC client that spawns an MCP server process, or an HTTP/SSE client. The seam
 * keeps the tool contract testable against an in-process client without needing a live server.
 *
 * SECURITY: the capability class is `network` (external-server I/O), so the child-policy
 * filter drops `mcp` from delegated subagents by default (it is not child-safe). A server's
 * tool surface is opaque to mission-control, so the model-facing output is bounded + the
 * client is expected to enforce its own server-side permission model.
 */
import { z } from 'zod';
import type { ToolRegistration } from './tool-registry-types.js';
import { ToolExecutionError } from './tool-registry-types.js';
import { truncateOutput, withContinuationHint } from './truncate.js';

/** A tool exposed by the connected MCP server (mirrors MCP `Tool`). */
export type McpToolInfo = {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema?: unknown;
};

/**
 * The MCP client seam. Real implementations connect to an MCP server (stdio child process or
 * HTTP/SSE) and speak JSON-RPC; the in-process `InProcessMcpClient` (below) serves tests.
 */
export type McpClient = {
    /** List the tools the connected server exposes. */
    listTools(): Promise<readonly McpToolInfo[]>;
    /** Invoke a named tool with JSON arguments; returns its result (opaque to mission-control). */
    callTool(input: { readonly name: string; readonly arguments?: unknown }): Promise<unknown>;
};

const mcpInputSchema = z.object({
    tool: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
});
export type McpInput = z.infer<typeof mcpInputSchema>;

const mcpOutputSchema = z.object({
    tool: z.string(),
    result: z.unknown(),
    truncated: z.boolean(),
});
export type McpOutput = z.infer<typeof mcpOutputSchema>;

export type CreateMcpToolInput = {
    readonly client: McpClient;
    readonly maxModelOutputChars?: number;
};

const DEFAULT_MCP_OUTPUT_LIMIT = 8000;

export function createMcpToolRegistration(input: CreateMcpToolInput): ToolRegistration<McpInput, McpOutput> {
    const limit = input.maxModelOutputChars ?? DEFAULT_MCP_OUTPUT_LIMIT;
    return {
        name: 'mcp',
        description:
            'Call a tool exposed by the connected Model Context Protocol server. ' +
            'Use for delegating to external, server-managed capabilities (databases, APIs, custom servers).',
        capabilityClasses: ['network'],
        parametersJsonSchema: {
            type: 'object',
            properties: {
                tool: { type: 'string', description: 'The MCP server tool to invoke.' },
                arguments: { type: 'object', description: 'JSON arguments for the server tool.' },
            },
            required: ['tool'],
            additionalProperties: false,
        },
        inputSchema: mcpInputSchema,
        outputSchema: mcpOutputSchema,
        outputLimit: { maxModelOutputChars: limit },
        execute: async (toolInput) => {
            try {
                const result = await input.client.callTool({
                    name: toolInput.tool,
                    ...(toolInput.arguments !== undefined ? { arguments: toolInput.arguments } : {}),
                });
                return { tool: toolInput.tool, result, truncated: false };
            } catch (error) {
                throw new ToolExecutionError({
                    code: 'tool_failed',
                    message: `mcp "${toolInput.tool}" failed: ${error instanceof Error ? error.message : String(error)}`,
                    retryable: true,
                });
            }
        },
        toModelOutput: (output) => {
            const text = typeof output.result === 'string' ? output.result : safeStringify(output.result);
            const truncated = truncateOutput(text, limit);
            return withContinuationHint(truncated, '');
        },
    };
}

/** In-process MCP client for tests + scripted server surfaces (no real transport). */
export class InProcessMcpClient implements McpClient {
    private readonly tools: ReadonlyMap<string, (args: unknown) => unknown>;

    constructor(
        tools: ReadonlyArray<{
            readonly name: string;
            readonly description?: string;
            readonly call: (args: unknown) => unknown;
        }>,
    ) {
        this.tools = new Map(tools.map((tool) => [tool.name, tool.call]));
        this.descriptions = tools.map((tool) => ({
            name: tool.name,
            ...(tool.description !== undefined ? { description: tool.description } : {}),
        }));
    }

    private readonly descriptions: readonly McpToolInfo[];

    async listTools(): Promise<readonly McpToolInfo[]> {
        return this.descriptions;
    }

    async callTool(request: { readonly name: string; readonly arguments?: unknown }): Promise<unknown> {
        const call = this.tools.get(request.name);
        if (call === undefined) {
            throw new ToolExecutionError({
                code: 'tool_failed',
                message: `mcp server exposes no tool named "${request.name}"`,
                retryable: false,
            });
        }
        return call(request.arguments);
    }
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
