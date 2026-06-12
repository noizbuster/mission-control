import type { ProviderStreamChunk } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createStaticProviderCredentialResolver } from '../credential-resolver.js';
import type { ProviderTurnRequest } from '../provider-turn-types.js';
import { createNodeGeminiGenerateContentTransport } from './gemini-generate-content-http-transport.js';
import { createGeminiGenerateContentProvider } from './gemini-generate-content-provider.js';

const { GOOGLE_API_KEY, MCTRL_GOOGLE_LIVE, MCTRL_GOOGLE_LIVE_MODEL } = process.env;
const liveEnabled = MCTRL_GOOGLE_LIVE === '1' && GOOGLE_API_KEY !== undefined;
const requiredEnvMessage = 'requires MCTRL_GOOGLE_LIVE=1 and GOOGLE_API_KEY';

describe.skipIf(!liveEnabled)(`Google Gemini live smoke (${requiredEnvMessage})`, () => {
    it(`streams a live response only when explicitly enabled (${requiredEnvMessage})`, async () => {
        // Given
        const apiKey = GOOGLE_API_KEY;
        if (apiKey === undefined) {
            throw new TypeError(`Google live smoke ${requiredEnvMessage}`);
        }
        const provider = createGeminiGenerateContentProvider({
            credentialResolver: createStaticProviderCredentialResolver([
                {
                    providerID: 'google',
                    type: 'apiKey',
                    apiKey,
                    createdAt: '2026-06-13T00:00:00.000Z',
                    updatedAt: '2026-06-13T00:00:00.000Z',
                },
            ]),
            transport: createNodeGeminiGenerateContentTransport(),
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
        requestId: 'request_google_live',
        sessionId: 'session_google_live',
        turnId: 'turn_google_live',
        providerID: 'google',
        modelID: MCTRL_GOOGLE_LIVE_MODEL ?? 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Reply with exactly: mission-control live smoke' }],
    };
}
