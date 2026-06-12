import { describe, expect, it } from 'vitest';
import { createStaticProviderCredentialResolver } from '../credential-resolver.js';
import { createOpenAICompatibleProvider, type OpenAICompatibleTransport } from './openai-compatible-provider.js';
import { collectChunks, createProviderContext, credential, turnRequest } from './openai-compatible-test-support.js';

describe('OpenAI-compatible unsupported provider guard', () => {
    it('fails providers without explicit compatible-adapter proof before transport execution', async () => {
        // Given
        let transportWasCalled = false;
        const transport: OpenAICompatibleTransport = {
            stream() {
                transportWasCalled = true;
                return unusedStream();
            },
        };
        const provider = createOpenAICompatibleProvider({
            credentialResolver: createStaticProviderCredentialResolver([credential('cohere', 'sk-cohere-secret')]),
            transport,
        });

        // When / Then
        await expect(
            collectChunks(provider.streamTurn(turnRequest({ providerID: 'cohere' }), createProviderContext())),
        ).rejects.toMatchObject({
            error: {
                code: 'unknown',
                message: 'provider cohere is not configured for the OpenAI-compatible adapter',
                retryable: false,
            },
        });
        expect(transportWasCalled).toBe(false);
    });
});

async function* unusedStream(): AsyncIterable<unknown> {
    yield { id: 'unused', choices: [] };
}
