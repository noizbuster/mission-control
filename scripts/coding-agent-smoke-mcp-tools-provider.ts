/**
 * Scripted tool-calling provider for the expanded tool set + MCP smoke (todo 13).
 *
 * The existing `scriptedCodingSmokeProvider` emits read/edit/write/bash tool calls — it cannot
 * prove the expanded surface (glob, namespaced `mcp__*` tools, skill) or the enriched system
 * prompt (`# Available tools`, `# Guidelines`, `<available_skills>`) are wired through the real
 * graph tool loop. This provider fills that gap: turn 1 proposes a `glob` call and a namespaced
 * `mcp__<server>__echo` call so the graph executes them through the merged registry; turn 2
 * (after tool results arrive) emits a final assistant text and stops.
 *
 * The provider also captures the system-message text from the first turn's `request.messages` so
 * the smoke can assert the assembled prompt contains the expected sections and the `mcp__*`
 * advertisement.
 *
 * Design constraints (from todo 13 spec):
 * - Deterministic: no network, no timers, no flakiness. The only branching is request-count-based.
 * - Credential-free: drives the flat-provider bridge over the graph engine (no real provider).
 * - The server name is configurable so the smoke can match the `.mcp.json` fixture name.
 */
import type { ProviderAdapter, ProviderTurnRequest } from '../packages/core/src/index.js';
import type { AgentMessage, ProviderStreamChunk } from '../packages/protocol/src/index.js';

export type ScriptedMcpToolsCapture = {
    /** Captured system-message text from each provider turn (for smoke assertions). */
    readonly systemPrompts: string[];
    /** Incremented on each `streamTurn` invocation so the provider can branch deterministically. */
    turnCount: { value: number };
};

export function createScriptedMcpToolsCapture(): ScriptedMcpToolsCapture {
    return { systemPrompts: [], turnCount: { value: 0 } };
}

export type ScriptedMcpToolsProviderOptions = {
    /** The MCP server name as it appears in `.mcp.json` (determines the `mcp__<name>__echo` tool id). */
    readonly fixtureServerName?: string;
};

/**
 * Build the scripted flat `ProviderAdapter` the graph engine drives for the MCP-tools smoke.
 *
 * Turn 1: proposes `glob({ pattern: '**\/*.txt' })` and `mcp__<server>__echo({ text: ... })`,
 * finishing with `tool_calls` so the graph's self-edge re-enters the LLM actor after the tools
 * settle. Turn 2 (after tool-result messages): emits a final assistant text and stops.
 */
export function scriptedMcpToolsSmokeProvider(
    capture: ScriptedMcpToolsCapture,
    options: ScriptedMcpToolsProviderOptions = {},
): ProviderAdapter {
    const serverName = options.fixtureServerName ?? 'fixture';
    const echoToolName = `mcp__${serverName}__echo`;
    return {
        async *streamTurn(request) {
            capture.turnCount.value += 1;
            captureSystemPrompt(capture, request);
            if (capture.turnCount.value === 1) {
                yield toolCallChunk(request, 1, 'smoke_glob_call', 'glob', { pattern: '**/*.txt' });
                yield toolCallChunk(request, 2, 'smoke_mcp_echo_call', echoToolName, {
                    text: 'hello from mcp tools smoke',
                });
                yield completedChunk(request, 3, 'requested glob and mcp echo', [
                    'smoke_glob_call',
                    'smoke_mcp_echo_call',
                ]);
                return;
            }
            yield completedChunk(request, 1, 'mcp tools smoke completed: glob and mcp echo settled');
        },
    };
}

function captureSystemPrompt(capture: ScriptedMcpToolsCapture, request: ProviderTurnRequest): void {
    for (const message of request.messages) {
        if (message.role === 'system') {
            capture.systemPrompts.push(message.content);
            return;
        }
    }
}

function toolCallChunk(
    request: ProviderTurnRequest,
    sequence: number,
    toolCallId: string,
    toolName: string,
    argumentsValue: Readonly<Record<string, unknown>>,
): ProviderStreamChunk {
    return {
        kind: 'tool_call_completed',
        requestId: request.requestId,
        sequence,
        toolCall: {
            toolCallId,
            toolName,
            argumentsJson: JSON.stringify(argumentsValue),
        },
    };
}

function completedChunk(
    request: ProviderTurnRequest,
    sequence: number,
    content: string,
    toolCallIds?: readonly string[],
): ProviderStreamChunk {
    return {
        kind: 'response_completed',
        requestId: request.requestId,
        sequence,
        message: {
            messageId: `message_${request.turnId}_${sequence}`,
            role: 'assistant',
            content,
            ...(toolCallIds !== undefined ? { toolCallIds: [...toolCallIds] } : {}),
        },
        finishReason: toolCallIds === undefined ? 'stop' : 'tool_calls',
    };
}

/**
 * Extract the system-message text from a list of `AgentMessage`s (first system-role entry).
 * Returns an empty string when no system message is present.
 */
export function extractSystemPrompt(messages: readonly AgentMessage[]): string {
    for (const message of messages) {
        if (message.role === 'system') {
            return message.content;
        }
    }
    return '';
}
