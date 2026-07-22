import { createDeterministicProvider, openLocalSessionEventStore } from '@mission-control/core';
import type { AbgGraphSpec } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { startCodingAgentTurn } from './interactive-coding-agent';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const usageBeforeNextNodeGraph: AbgGraphSpec = {
    id: 'live-usage-before-next-node',
    entryNodeId: 'usage-source',
    nodes: [
        { id: 'usage-source', kind: 'llm' },
        { id: 'after-usage', kind: 'memory', config: { op: 'has', key: 'marker' } },
    ],
    edges: [{ source: 'usage-source', target: 'after-usage' }],
    rules: [],
    policies: [],
};

describe('interactive coding run owner live usage', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('reports turn usage before the next live graph node starts', async () => {
        // Given
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-live-usage-'));
        tempRoots.push(workspaceRoot);
        const sessionId = 'session-live-usage-order';
        const store = await openLocalSessionEventStore({ dataDir: workspaceRoot, sessionId });
        const observations: string[] = [];

        try {
            // When
            const turn = await startCodingAgentTurn({
                prompt: 'report usage before continuing',
                sessionId,
                turnId: 'turn-live-usage-order',
                store,
                provider: createDeterministicProvider([
                    {
                        kind: 'response_completed',
                        content: 'done',
                        usage: { inputTokens: 4200, outputTokens: 80, totalTokens: 4280 },
                    },
                ]),
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                workspaceRoot,
                graph: usageBeforeNextNodeGraph,
                output: {
                    write: () => undefined,
                    setAgentStatus: (status) => observations.push(`status:${status}`),
                },
                emitEvent: () => undefined,
                onUsage: (inputTokens) => observations.push(`usage:${String(inputTokens)}`),
            });
            await turn.done;

            // Then
            const firstUsageIndex = observations.indexOf('usage:4200');
            const nextNodeIndex = observations.findIndex((entry) => entry.includes('after usage'));
            expect(firstUsageIndex).toBeGreaterThanOrEqual(0);
            expect(nextNodeIndex).toBeGreaterThanOrEqual(0);
            expect(firstUsageIndex).toBeLessThan(nextNodeIndex);
        } finally {
            await store.close();
        }
    });
});
