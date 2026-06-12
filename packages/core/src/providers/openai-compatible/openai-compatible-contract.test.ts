import { expect, it } from 'vitest';
import { createStaticProviderCredentialResolver } from '../credential-resolver.js';
import { openAICompatibleProviderContract } from '../provider-adapter-contract-registrations.js';
import { describeProviderAdapterContract } from '../provider-adapter-contract-test-support.js';
import { createOpenAICompatibleProvider, OpenAICompatibleTransportError } from './openai-compatible-provider.js';
import { collectChunks, createProviderContext, credential, turnRequest } from './openai-compatible-test-support.js';

describeProviderAdapterContract(openAICompatibleProviderContract);

it('maps abort failures without leaking compatible provider tokens', async () => {
    // Given
    const provider = createOpenAICompatibleProvider({
        credentialResolver: createStaticProviderCredentialResolver([
            credential('openrouter', 'sk-openrouter-contract-secret'),
        ]),
        transport: {
            stream() {
                throw new OpenAICompatibleTransportError({
                    kind: 'abort',
                    message: 'aborted sk-openrouter-contract-secret',
                });
            },
        },
    });

    // When / Then
    await expect(collectChunks(provider.streamTurn(turnRequest(), createProviderContext()))).rejects.toMatchObject({
        error: {
            code: 'provider_aborted',
            message: 'aborted [REDACTED_CREDENTIAL]',
            retryable: false,
        },
    });
});

it('maps retryable rate-limit failures without leaking compatible provider tokens', async () => {
    // Given
    const provider = createOpenAICompatibleProvider({
        credentialResolver: createStaticProviderCredentialResolver([
            credential('openrouter', 'sk-openrouter-contract-secret'),
        ]),
        transport: {
            stream() {
                throw new OpenAICompatibleTransportError({
                    status: 429,
                    message: 'rate limited sk-openrouter-contract-secret',
                });
            },
        },
    });

    // When / Then
    await expect(collectChunks(provider.streamTurn(turnRequest(), createProviderContext()))).rejects.toMatchObject({
        error: {
            code: 'provider_rate_limited',
            message: 'rate limited [REDACTED_CREDENTIAL]',
            retryable: true,
        },
    });
});
