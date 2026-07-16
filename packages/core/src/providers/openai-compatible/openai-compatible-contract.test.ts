import { expect, it } from 'vitest';
import { createStaticProviderCredentialResolver } from '../credential-resolver';
import { openAICompatibleProviderContract } from '../provider-adapter-contract-registrations';
import { describeProviderAdapterContract } from '../provider-adapter-contract-test-support';
import { createOpenAICompatibleProvider, OpenAICompatibleTransportError } from './openai-compatible-provider';
import { collectChunks, createProviderContext, credential, turnRequest } from './openai-compatible-test-support';

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

it('maps 503 overloaded failures as retryable rate limits without leaking tokens', async () => {
    const provider = createOpenAICompatibleProvider({
        credentialResolver: createStaticProviderCredentialResolver([
            credential('zai-coding-plan', 'sk-zai-contract-secret'),
        ]),
        transport: {
            stream() {
                throw new OpenAICompatibleTransportError({
                    status: 503,
                    message: 'The service may be temporarily overloaded, please try again later sk-zai-contract-secret',
                });
            },
        },
    });

    const request = turnRequest({ providerID: 'zai-coding-plan' });
    await expect(collectChunks(provider.streamTurn(request, createProviderContext()))).rejects.toMatchObject({
        error: {
            code: 'provider_rate_limited',
            message: expect.stringContaining('temporarily overloaded'),
            retryable: true,
        },
    });
    try {
        await collectChunks(provider.streamTurn(request, createProviderContext()));
        expect.unreachable('expected transport failure');
    } catch (error) {
        expect(JSON.stringify(error)).not.toContain('sk-zai-contract-secret');
    }
});
