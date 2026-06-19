import { describe, expect, it } from 'vitest';
import type { ProviderTurnRequest } from '../packages/core/src/index.js';
import type { AgentMessage, ProviderStreamChunk } from '../packages/protocol/src/index.js';
import {
    createScriptedMcpToolsCapture,
    extractSystemPrompt,
    scriptedMcpToolsSmokeProvider,
} from './coding-agent-smoke-mcp-tools-provider.js';

const SYSTEM_PROMPT_FIXTURE =
    'You are a coding agent.\n\n# Available tools\n- glob: find files\n- mcp__fixture__echo: echo';

function mockRequest(messages: readonly AgentMessage[]): ProviderTurnRequest {
    return {
        requestId: 'test_request',
        sessionId: 'session_test',
        turnId: 'turn_test',
        providerID: 'local',
        modelID: 'local-echo',
        messages,
    };
}

function systemMessage(content: string): AgentMessage {
    return { role: 'system', content };
}

function userMessage(content: string): AgentMessage {
    return { role: 'user', content };
}

function toolResultMessage(toolCallId: string): AgentMessage {
    return {
        role: 'tool',
        toolCallId,
        status: 'completed',
        output: 'tool completed',
    };
}

async function collectChunks(
    provider: ReturnType<typeof scriptedMcpToolsSmokeProvider>,
    request: ProviderTurnRequest,
): Promise<ProviderStreamChunk[]> {
    const chunks: ProviderStreamChunk[] = [];
    for await (const chunk of provider.streamTurn(request, { attempt: 1, signal: new AbortController().signal })) {
        chunks.push(chunk);
    }
    return chunks;
}

function toolCallNames(chunks: readonly ProviderStreamChunk[]): readonly string[] {
    return chunks
        .filter(
            (chunk): chunk is Extract<ProviderStreamChunk, { readonly kind: 'tool_call_completed' }> =>
                chunk.kind === 'tool_call_completed',
        )
        .map((chunk) => chunk.toolCall.toolName);
}

function findCompleted(
    chunks: readonly ProviderStreamChunk[],
): Extract<ProviderStreamChunk, { readonly kind: 'response_completed' }> | undefined {
    return chunks.find(
        (chunk): chunk is Extract<ProviderStreamChunk, { readonly kind: 'response_completed' }> =>
            chunk.kind === 'response_completed',
    );
}

describe('scriptedMcpToolsSmokeProvider', () => {
    it('emits glob and mcp__fixture__echo tool calls on turn 1', async () => {
        const capture = createScriptedMcpToolsCapture();
        const provider = scriptedMcpToolsSmokeProvider(capture);
        const request = mockRequest([systemMessage(SYSTEM_PROMPT_FIXTURE), userMessage('explore')]);

        const chunks = await collectChunks(provider, request);
        const names = toolCallNames(chunks);

        expect(names).toEqual(['glob', 'mcp__fixture__echo']);
        const completed = findCompleted(chunks);
        expect(completed?.finishReason).toBe('tool_calls');
    });

    it('emits final assistant text on turn 2 (after tool results)', async () => {
        const capture = createScriptedMcpToolsCapture();
        const provider = scriptedMcpToolsSmokeProvider(capture);

        const turn1Request = mockRequest([systemMessage(SYSTEM_PROMPT_FIXTURE), userMessage('explore')]);
        await collectChunks(provider, turn1Request);

        const turn2Request = mockRequest([
            systemMessage(SYSTEM_PROMPT_FIXTURE),
            userMessage('explore'),
            toolResultMessage('smoke_glob_call'),
            toolResultMessage('smoke_mcp_echo_call'),
        ]);
        const chunks = await collectChunks(provider, turn2Request);

        const completed = findCompleted(chunks);
        expect(completed).toBeDefined();
        expect(completed?.finishReason).toBe('stop');
        expect(completed?.message.content).toContain('mcp tools smoke completed');
    });

    it('captures the system prompt from request messages', async () => {
        const capture = createScriptedMcpToolsCapture();
        const provider = scriptedMcpToolsSmokeProvider(capture);
        const request = mockRequest([systemMessage(SYSTEM_PROMPT_FIXTURE), userMessage('explore')]);

        await collectChunks(provider, request);

        expect(capture.systemPrompts).toHaveLength(1);
        expect(capture.systemPrompts[0]).toContain('# Available tools');
        expect(capture.systemPrompts[0]).toContain('mcp__fixture__echo');
    });

    it('uses the configured fixture server name for the mcp tool id', async () => {
        const capture = createScriptedMcpToolsCapture();
        const provider = scriptedMcpToolsSmokeProvider(capture, { fixtureServerName: 'custom' });
        const request = mockRequest([systemMessage('test'), userMessage('explore')]);

        const chunks = await collectChunks(provider, request);
        const names = toolCallNames(chunks);

        expect(names).toEqual(['glob', 'mcp__custom__echo']);
    });

    it('extractSystemPrompt returns the first system message content', () => {
        const messages: readonly AgentMessage[] = [
            systemMessage('first system'),
            userMessage('hello'),
            systemMessage('second system'),
        ];
        expect(extractSystemPrompt(messages)).toBe('first system');
    });

    it('extractSystemPrompt returns empty string when no system message is present', () => {
        const messages: readonly AgentMessage[] = [userMessage('hello')];
        expect(extractSystemPrompt(messages)).toBe('');
    });
});
