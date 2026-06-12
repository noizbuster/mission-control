import type { ProviderStreamChunk } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createStaticProviderCredentialResolver } from '../credential-resolver.js';
import type { ProviderTurnRequest } from '../provider-turn-types.js';
import { createNodeOpenAICompatibleTransport } from './openai-compatible-http-transport.js';
import { createOpenAICompatibleProvider } from './openai-compatible-provider.js';

const { MCTRL_OPENAI_COMPATIBLE_LIVE, MCTRL_OPENAI_COMPATIBLE_LIVE_MODEL, OPENROUTER_API_KEY } = process.env;
const liveEnabled = MCTRL_OPENAI_COMPATIBLE_LIVE === '1' && OPENROUTER_API_KEY !== undefined;
const requiredEnvMessage = 'requires MCTRL_OPENAI_COMPATIBLE_LIVE=1 and OPENROUTER_API_KEY';

describe.skipIf(!liveEnabled)(`OpenAI-compatible OpenRouter live smoke (${requiredEnvMessage})`, () => {
    it(`streams a live response only when explicitly enabled (${requiredEnvMessage})`, async () => {
        // Given
        const apiKey = OPENROUTER_API_KEY;
        if (apiKey === undefined) {
            throw new TypeError(`OpenAI-compatible live smoke ${requiredEnvMessage}`);
        }
        const provider = createOpenAICompatibleProvider({
            credentialResolver: createStaticProviderCredentialResolver([
                {
                    providerID: 'openrouter',
                    type: 'apiKey',
                    apiKey,
                    createdAt: '2026-06-13T00:00:00.000Z',
                    updatedAt: '2026-06-13T00:00:00.000Z',
                },
            ]),
            transport: createNodeOpenAICompatibleTransport(),
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
        requestId: 'request_openrouter_live',
        sessionId: 'session_openrouter_live',
        turnId: 'turn_openrouter_live',
        providerID: 'openrouter',
        modelID: MCTRL_OPENAI_COMPATIBLE_LIVE_MODEL ?? 'anthropic/claude-3.5-haiku',
        messages: [{ role: 'user', content: 'Reply with exactly: mission-control live smoke' }],
    };
}
