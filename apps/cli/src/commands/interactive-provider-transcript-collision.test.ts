import { createChatStore } from '@mission-control/tui/state';
import { describe, expect, it } from 'vitest';
import { createStoreChatOutput } from './store-chat-output';
import { renderProviderEnvelope } from './interactive-coding-provider-rendering';
import { createProviderRenderState } from './interactive-coding-transcript-render-state';
import { providerEnvelope } from './interactive-transcript-emission-test-support';

describe('provider transcript lane identity', () => {
    it('keeps assistant and reasoning rows independent when the provider reuses one request ID', () => {
        // Given
        const store = createChatStore();
        const output = createStoreChatOutput(store);
        const state = createProviderRenderState('outer-provider');
        const requestId = 'shared-request';

        // When
        renderProviderEnvelope(
            output,
            state,
            providerEnvelope({
                kind: 'text_delta',
                requestId,
                sequence: 1,
                delta: 'draft',
            }),
        );
        renderProviderEnvelope(
            output,
            state,
            providerEnvelope({
                kind: 'reasoning_delta',
                requestId,
                sequence: 2,
                delta: 'inspect',
            }),
        );
        renderProviderEnvelope(
            output,
            state,
            providerEnvelope({
                kind: 'text_delta',
                requestId,
                sequence: 3,
                delta: ' answer',
            }),
        );
        renderProviderEnvelope(
            output,
            state,
            providerEnvelope({
                kind: 'reasoning_completed',
                requestId,
                sequence: 4,
                text: 'inspect evidence',
            }),
        );
        renderProviderEnvelope(
            output,
            state,
            providerEnvelope({
                kind: 'response_completed',
                requestId,
                sequence: 5,
                message: { messageId: 'message-shared', role: 'assistant', content: 'draft answer' },
                finishReason: 'stop',
            }),
        );

        // Then
        expect(store.getSnapshot().transcriptParts).toEqual([
            {
                id: 'provider:outer-provider:shared-request:assistant',
                type: 'assistant',
                text: 'draft answer',
                status: 'completed',
                messageId: 'message-shared',
                requestId: 'shared-request',
            },
            {
                id: 'provider:outer-provider:shared-request:reasoning',
                type: 'reasoning',
                text: 'inspect evidence',
                status: 'completed',
                requestId: 'shared-request',
            },
        ]);
        expect(store.getOutput()).toBe('Assistant: draft answer\n');
    });
});
