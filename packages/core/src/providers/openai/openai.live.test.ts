import type { ProviderStreamChunk } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createStaticProviderCredentialResolver } from '../credential-resolver.js';
import type { ProviderTurnRequest } from '../provider-turn-types.js';
import { createNodeOpenAIResponsesTransport } from './openai-responses-http-transport.js';
import { createOpenAIResponsesProvider } from './openai-responses-provider.js';

const liveEnabled = process.env['MCTRL_OPENAI_LIVE'] === '1' && process.env['OPENAI_API_KEY'] !== undefined;

describe.skipIf(!liveEnabled)('OpenAI Responses live smoke', () => {
    it('streams a live response only when explicitly enabled', async () => {
        // Given
        const apiKey = process.env['OPENAI_API_KEY'];
        if (apiKey === undefined) {
            throw new TypeError('OPENAI_API_KEY is required for live smoke');
        }
        const provider = createOpenAIResponsesProvider({
            credentialResolver: createStaticProviderCredentialResolver([
                {
                    providerID: 'openai',
                    type: 'apiKey',
                    apiKey,
                    createdAt: '2026-06-09T10:00:00.000Z',
                    updatedAt: '2026-06-09T10:00:00.000Z',
                },
            ]),
            transport: createNodeOpenAIResponsesTransport(),
        });

        // When
        const chunks: ProviderStreamChunk[] = [];
        for await (const chunk of provider.streamTurn(turnRequest(), {
            attempt: 1,
            signal: new AbortController().signal,
        })) {
            chunks.push(chunk);
        }

        // Then
        expect(chunks.some((chunk) => chunk.kind === 'response_completed')).toBe(true);
        expect(JSON.stringify(chunks)).not.toContain(apiKey);
    });
});

function turnRequest(): ProviderTurnRequest {
    return {
        requestId: 'request_openai_live',
        sessionId: 'session_openai_live',
        turnId: 'turn_openai_live',
        providerID: 'openai',
        modelID: process.env['MCTRL_OPENAI_LIVE_MODEL'] ?? 'gpt-5.5',
        messages: [{ role: 'user', content: 'Reply with exactly: mission-control live smoke' }],
    };
}
