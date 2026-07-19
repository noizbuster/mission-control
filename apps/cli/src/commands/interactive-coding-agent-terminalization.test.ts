import {
    createDeterministicProvider,
    createObservabilityRedactor,
    openLocalSessionEventStore,
} from '@mission-control/core';
import { createChatStore } from '@mission-control/tui/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCodingAgentTurn } from './interactive-coding-agent';
import type { CodingAgentTurnOptions } from './interactive-coding-agent-types';
import { seedActiveToolTranscriptParts } from './interactive-coding-run-settlement-test-support';
import type { ProviderRenderState } from './interactive-coding-transcript-render-state';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const crashMessage = 'owner submit exploded';
let capturedRenderState: ProviderRenderState | undefined;

vi.mock('./interactive-coding-run-owner', () => ({
    createInteractiveRunOwner: vi.fn(
        async (options: CodingAgentTurnOptions, _approvals: unknown, renderState: ProviderRenderState) => {
            capturedRenderState = renderState;
            seedActiveToolTranscriptParts(options.output, renderState);
            return {
                owner: {
                    submit: async () => {
                        throw new Error(crashMessage);
                    },
                    status: () => ({
                        sessionId: options.sessionId,
                        runId: 'run-thrown',
                        status: 'running',
                        turns: 1,
                    }),
                    release: async () => undefined,
                    interrupt: async () => ({
                        sessionId: options.sessionId,
                        runId: 'run-thrown',
                        status: 'interrupted',
                        turns: 1,
                    }),
                },
                tools: {},
                observabilityRedactor: createObservabilityRedactor(),
                overlayWiring: undefined,
            };
        },
    ),
}));

vi.mock('./production-tool-registry', () => ({
    closeProductionToolRegistry: vi.fn(async () => undefined),
}));

describe('thrown coding-turn active tool terminalization', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        capturedRenderState = undefined;
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('upserts rich base and preview rows as failed before preserving the exact crash fallback', async () => {
        // Given
        const store = createChatStore();
        const output = {
            write: (text: string) => store.emitOutput(text),
            writeTranscriptPart: (part: Parameters<typeof store.emitTranscriptPart>[0], fallbackText: string) =>
                store.emitTranscriptPart(part, fallbackText),
            writeTranscriptFallback: (text: string) => store.emitTranscriptFallback(text),
        };
        const options = await turnOptions(output, tempRoots);

        // When
        const turn = await startCodingAgentTurn(options);
        await expect(turn.outcome).resolves.toBe('failed');
        await turn.done;

        // Then
        const activeRows = store
            .getSnapshot()
            .transcriptParts.filter((part) => part.id.startsWith('tool:turn-thrown:active-command:'));
        expect(activeRows.map((part) => ({ id: part.id, status: 'status' in part ? part.status : undefined }))).toEqual(
            [
                {
                    id: 'tool:turn-thrown:active-command:occurrence:1',
                    status: 'failed',
                },
                {
                    id: 'tool:turn-thrown:active-command:occurrence:1:preview',
                    status: 'failed',
                },
            ],
        );
        expect(store.getOutput()).toBe(`Error: ${crashMessage}\n`);
        expect(capturedRenderState?.activeToolTranscriptParts.size).toBe(0);
        expect(capturedRenderState?.pendingToolBaseIdsByRawId.size).toBe(0);
        await options.store.close();
    });

    it('writes no empty bytes to plain output while clearing thrown active allocation state', async () => {
        // Given
        const writes: string[] = [];
        const options = await turnOptions({ write: (text) => writes.push(text) }, tempRoots);

        // When
        const turn = await startCodingAgentTurn(options);
        await expect(turn.outcome).resolves.toBe('failed');
        await turn.done;

        // Then
        expect(writes).toEqual([`Error: ${crashMessage}\n`]);
        expect(capturedRenderState?.activeToolTranscriptParts.size).toBe(0);
        expect(capturedRenderState?.pendingToolBaseIdsByRawId.size).toBe(0);
        await options.store.close();
    });
});

async function turnOptions(
    output: CodingAgentTurnOptions['output'],
    tempRoots: string[],
): Promise<CodingAgentTurnOptions> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-thrown-terminalization-'));
    tempRoots.push(dataDir);
    const sessionId = `session-thrown-${tempRoots.length}`;
    return {
        prompt: 'trigger the thrown owner path',
        sessionId,
        turnId: 'turn-thrown',
        store: await openLocalSessionEventStore({ dataDir, sessionId }),
        provider: createDeterministicProvider([]),
        modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
        workspaceRoot: '/workspace',
        output,
        emitEvent: () => undefined,
    };
}
