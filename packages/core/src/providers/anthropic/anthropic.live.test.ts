import type { ProviderStreamChunk } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createStaticProviderCredentialResolver } from '../credential-resolver.js';
import type { ProviderTurnRequest } from '../provider-turn-types.js';
import { createNodeAnthropicMessagesTransport } from './anthropic-messages-http-transport.js';
import { createAnthropicMessagesProvider } from './anthropic-messages-provider.js';

const { ANTHROPIC_API_KEY, MCTRL_ANTHROPIC_LIVE, MCTRL_ANTHROPIC_LIVE_MODEL } = process.env;
const liveEnabled = MCTRL_ANTHROPIC_LIVE === '1' && ANTHROPIC_API_KEY !== undefined;
const requiredEnvMessage = 'requires MCTRL_ANTHROPIC_LIVE=1 and ANTHROPIC_API_KEY';

describe.skipIf(!liveEnabled)(`Anthropic Messages live smoke (${requiredEnvMessage})`, () => {
    it(`streams a live response only when explicitly enabled (${requiredEnvMessage})`, async () => {
        // Given
        const apiKey = ANTHROPIC_API_KEY;
        if (apiKey === undefined) {
            throw new TypeError(`Anthropic live smoke ${requiredEnvMessage}`);
        }
        const provider = createAnthropicMessagesProvider({
            credentialResolver: createStaticProviderCredentialResolver([
                {
                    providerID: 'anthropic',
                    type: 'apiKey',
                    apiKey,
                    createdAt: '2026-06-13T00:00:00.000Z',
                    updatedAt: '2026-06-13T00:00:00.000Z',
                },
            ]),
            transport: createNodeAnthropicMessagesTransport(),
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
        requestId: 'request_anthropic_live',
        sessionId: 'session_anthropic_live',
        turnId: 'turn_anthropic_live',
        providerID: 'anthropic',
        modelID: MCTRL_ANTHROPIC_LIVE_MODEL ?? 'claude-3-5-haiku-20241022',
        messages: [{ role: 'user', content: 'Reply with exactly: mission-control live smoke' }],
    };
}
