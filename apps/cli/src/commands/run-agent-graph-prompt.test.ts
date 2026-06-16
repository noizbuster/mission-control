/**
 * `--engine graph` wiring tests. `runCodingPromptOnGraph` is the additive strangler-fig seam
 * that constructs the graph wiring (registry + resolveSdkModel + toolRegistry +
 * initialMessages) `run-agent.ts` previously omitted, so `AgentRuntime.runGraph` drives a
 * REAL provider instead of the mock registry.
 *
 * The end-to-end "scripted model → completed graph run through the runtime" test mirrors
 * `agent-runtime-coding-agent.test.ts` (which proves the underlying `runGraph` mechanism);
 * here we prove the CLI helper assembles that same wiring. The flat loop is untouched.
 */
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { AgentRuntime, type SdkModelResolver, SdkModelResolverError, ToolRegistry } from '@mission-control/core';
import { runCodingPromptOnGraph } from './run-agent-graph-prompt.js';

const SELECTION = { providerID: 'openai', modelID: 'gpt-test' } as const;

function buildUsage() {
    return {
        inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 6, text: 6, reasoning: 0 },
    };
}

function finalTextChunks(): LanguageModelV3StreamPart[] {
    return [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't2' },
        { type: 'text-delta', id: 't2', delta: 'Done.' },
        { type: 'text-end', id: 't2' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: buildUsage() },
    ];
}

describe('runCodingPromptOnGraph (--engine graph wiring)', () => {
    it('drives the coding-agent graph through the runtime with a scripted model', async () => {
        const runtime = new AgentRuntime({ modelProviderSelection: SELECTION });
        await runtime.start();
        try {
            const model = new MockLanguageModelV3({
                provider: SELECTION.providerID,
                modelId: SELECTION.modelID,
                doStream: async () => ({ stream: convertArrayToReadableStream(finalTextChunks()) }),
            });

            const result = await runCodingPromptOnGraph({
                runtime,
                selection: SELECTION,
                prompt: 'just answer',
                workspaceRoot: process.cwd(),
                resolveSdkModel: () => model,
                toolRegistry: new ToolRegistry(),
            });

            expect(result.status).toBe('completed');
            expect(model.doStreamCalls.length).toBe(1);

            const messages = runtime.getEvents().map((event) => event.message ?? '').join('\n');
            expect(messages).toContain('llm.turn.completed');
        } finally {
            await runtime.stop();
        }
    });

    it('rejects a provider with no AI-SDK mapping with a clear error before the run starts', async () => {
        const runtime = new AgentRuntime({ modelProviderSelection: { providerID: 'local', modelID: 'x' } });
        await runtime.start();
        try {
            const throwingResolver: SdkModelResolver = () => {
                throw new SdkModelResolverError('no mapping');
            };
            await expect(
                runCodingPromptOnGraph({
                    runtime,
                    selection: { providerID: 'local', modelID: 'x' },
                    prompt: 'hi',
                    workspaceRoot: process.cwd(),
                    resolveSdkModel: throwingResolver,
                    toolRegistry: new ToolRegistry(),
                }),
            ).rejects.toThrow(/graph engine supports AI-SDK-backed providers/);
        } finally {
            await runtime.stop();
        }
    });

    it('requires an auth store when no resolver is injected', async () => {
        const runtime = new AgentRuntime({ modelProviderSelection: SELECTION });
        await runtime.start();
        try {
            await expect(
                runCodingPromptOnGraph({
                    runtime,
                    selection: SELECTION,
                    prompt: 'hi',
                    workspaceRoot: process.cwd(),
                    toolRegistry: new ToolRegistry(),
                }),
            ).rejects.toThrow(/injected resolver or an auth store/);
        } finally {
            await runtime.stop();
        }
    });
});
