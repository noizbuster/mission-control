import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { AgentRuntime, ProjectTrustStore } from '@mission-control/core';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCodingPromptOnGraph } from './run-agent-graph-prompt';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const selection = { providerID: 'openai', modelID: 'gpt-test' } as const;
const tempDirs: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runCodingPromptOnGraph eval approval', () => {
    it('registers eval for a trusted workspace and blocks it before execution without approval', async () => {
        const dataDir = await makeTempDir('mission-control-graph-eval-data-');
        const workspaceRoot = await makeTempDir('mission-control-graph-eval-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await new ProjectTrustStore({ dataDir }).setDecision(workspaceRoot, 'trusted');
        const markerPath = join(workspaceRoot, 'eval-must-not-run.txt');
        const rawCode = `secret = "graph-eval-event-secret"\nopen(${JSON.stringify(markerPath)}, 'w').write(secret)`;
        const model = new MockLanguageModelV3({
            provider: selection.providerID,
            modelId: selection.modelID,
            doStream: async () => ({
                stream: convertArrayToReadableStream(evalCallChunks(rawCode)),
            }),
        });
        const runtime = new AgentRuntime({ modelProviderSelection: selection });
        await runtime.start();

        try {
            const result = await runCodingPromptOnGraph({
                runtime,
                selection,
                prompt: 'run eval',
                workspaceRoot,
                resolveSdkModel: () => model,
            });
            expect(result.status).toBe('failed');
            expect(runtime.getEvents().map((event) => event.message ?? '')).toContain('approval blocked: eval');
            expect(JSON.stringify(runtime.getEvents())).not.toContain(rawCode);
            expect(JSON.stringify(runtime.getEvents())).not.toContain('graph-eval-event-secret');
            expect(existsSync(markerPath)).toBe(false);
        } finally {
            await runtime.stop();
        }
    });
});

async function makeTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function evalCallChunks(code: string): LanguageModelV3StreamPart[] {
    const input = JSON.stringify({ cells: [{ language: 'py', code }] });
    return [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-input-start', id: 'call_eval', toolName: 'eval' },
        { type: 'tool-input-delta', id: 'call_eval', delta: input },
        { type: 'tool-input-end', id: 'call_eval' },
        { type: 'tool-call', toolCallId: 'call_eval', toolName: 'eval', input },
        {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage: {
                inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 6, text: 6, reasoning: 0 },
            },
        },
    ];
}
