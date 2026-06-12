import type { ProviderTurnRequest } from '@mission-control/core';
import { describe, expect, it } from 'vitest';
import { createLocalCodingProvider } from './local-coding-provider.js';

describe('createLocalCodingProvider', () => {
    it('returns a final answer instead of repeating deterministic tools after tool results', async () => {
        // Given
        const provider = createLocalCodingProvider();
        const request = requestWithMessages([
            { role: 'user', content: 'make a deterministic patch proposal and run the test' },
            { role: 'assistant', content: 'local deterministic coding turn complete' },
            {
                role: 'tool',
                toolCallId: 'local_patch_call',
                status: 'completed',
                output: 'applied patch to .mission-control-coding-agent.txt',
            },
        ]);

        // When
        const chunks = await collectChunks(
            provider.streamTurn(request, { attempt: 1, signal: new AbortController().signal }),
        );

        // Then
        expect(chunks.map((chunk) => chunk.kind)).toEqual(['response_completed']);
        expect(chunks[0]).toEqual(
            expect.objectContaining({
                kind: 'response_completed',
                message: expect.objectContaining({ content: 'local deterministic coding turn complete' }),
            }),
        );
    });
});

function requestWithMessages(messages: ProviderTurnRequest['messages']): ProviderTurnRequest {
    return {
        requestId: 'provider_request_local_continue',
        sessionId: 'session_local',
        turnId: 'turn_local_continue',
        providerID: 'local',
        modelID: 'local-echo',
        messages,
    };
}

async function collectChunks<T>(chunks: AsyncIterable<T>): Promise<readonly T[]> {
    const collected: T[] = [];
    for await (const chunk of chunks) {
        collected.push(chunk);
    }
    return collected;
}
