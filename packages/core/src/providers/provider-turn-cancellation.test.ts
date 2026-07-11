import type { ProviderStreamChunk } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import type { SessionControlEpoch } from '../runtime/session-control-cancellation.js';
import { ProviderTurnRunner } from './provider-turn-runner.js';
import type { ProviderAdapter, ProviderAdapterContext } from './provider-turn-types.js';

const CONTROL_EPOCH: SessionControlEpoch = {
    dbIdentity: 'b'.repeat(64),
    sessionId: 'session-provider',
    ownerId: 'owner-provider',
    ownerEpoch: 3,
};

describe('provider turn session-control propagation', () => {
    it('forwards the owner epoch with the abort signal into every provider attempt', async () => {
        let observed: ProviderAdapterContext | undefined;
        const provider: ProviderAdapter = {
            streamTurn: (_request, context) => {
                observed = context;
                return completedStream();
            },
        };
        const runner = new ProviderTurnRunner({ provider });

        const result = await runner.runTurn({
            requestId: 'request-provider',
            sessionId: 'session-provider',
            turnId: 'turn-provider',
            providerID: 'test',
            modelID: 'test',
            messages: [{ role: 'user', content: 'hello' }],
            startSequence: 0,
            controlEpoch: CONTROL_EPOCH,
        });

        expect(result.status).toBe('completed');
        expect(observed?.controlEpoch).toEqual(CONTROL_EPOCH);
        expect(observed?.signal).toBeInstanceOf(AbortSignal);
    });
});

async function* completedStream(): AsyncIterable<ProviderStreamChunk> {
    yield {
        kind: 'response_completed',
        requestId: 'request-provider',
        sequence: 0,
        message: { messageId: 'message-provider', role: 'assistant', content: 'done' },
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
}
