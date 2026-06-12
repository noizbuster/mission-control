import { expect, it } from 'vitest';
import { createStaticProviderCredentialResolver } from '../credential-resolver.js';
import { googleGeminiProviderContract } from '../provider-adapter-contract-registrations.js';
import { describeProviderAdapterContract } from '../provider-adapter-contract-test-support.js';
import {
    createGeminiGenerateContentProvider,
    GeminiGenerateContentTransportError,
} from './gemini-generate-content-provider.js';
import {
    captureError,
    collectChunks,
    geminiCredential,
    geminiTurnRequest,
    throwingStream,
} from './gemini-generate-content-test-support.js';

describeProviderAdapterContract(googleGeminiProviderContract);

it('maps retryable Gemini rate-limit failures without leaking the API key', async () => {
    // Given
    const provider = createGeminiGenerateContentProvider({
        credentialResolver: createStaticProviderCredentialResolver([
            geminiCredential('google', 'sk-gemini-contract-secret'),
        ]),
        transport: {
            stream() {
                return throwingStream(
                    new GeminiGenerateContentTransportError({
                        status: 429,
                        message: 'rate limited sk-gemini-contract-secret',
                    }),
                );
            },
        },
    });

    // When
    const error = await captureError(
        collectChunks(provider.streamTurn(geminiTurnRequest(), { attempt: 1, signal: new AbortController().signal })),
    );

    // Then
    expect(error).toMatchObject({
        error: {
            code: 'provider_rate_limited',
            message: 'rate limited [REDACTED_CREDENTIAL]',
            retryable: true,
        },
    });
});
