import { expect, it } from 'vitest';
import { createStaticProviderCredentialResolver } from '../credential-resolver';
import { googleGeminiProviderContract } from '../provider-adapter-contract-registrations';
import { describeProviderAdapterContract } from '../provider-adapter-contract-test-support';
import {
    createGeminiGenerateContentProvider,
    GeminiGenerateContentTransportError,
} from './gemini-generate-content-provider';
import {
    captureError,
    collectChunks,
    geminiCredential,
    geminiTurnRequest,
    throwingStream,
} from './gemini-generate-content-test-support';

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
