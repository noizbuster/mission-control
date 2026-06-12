import { expect, it } from 'vitest';
import { createStaticProviderCredentialResolver } from '../credential-resolver.js';
import { anthropicMessagesProviderContract } from '../provider-adapter-contract-registrations.js';
import { describeProviderAdapterContract } from '../provider-adapter-contract-test-support.js';
import { AnthropicMessagesTransportError, createAnthropicMessagesProvider } from './anthropic-messages-provider.js';
import {
    anthropicCredential,
    anthropicTurnRequest,
    captureError,
    collectChunks,
    throwingStream,
} from './anthropic-messages-test-support.js';

describeProviderAdapterContract(anthropicMessagesProviderContract);

it('maps abort failures without leaking the Anthropic API key', async () => {
    // Given
    const provider = createAnthropicMessagesProvider({
        credentialResolver: createStaticProviderCredentialResolver([
            anthropicCredential('anthropic', 'sk-ant-contract-secret'),
        ]),
        transport: {
            stream() {
                return throwingStream(
                    new AnthropicMessagesTransportError({
                        kind: 'abort',
                        message: 'aborted sk-ant-contract-secret',
                    }),
                );
            },
        },
    });

    // When
    const error = await captureError(
        collectChunks(
            provider.streamTurn(anthropicTurnRequest(), { attempt: 1, signal: new AbortController().signal }),
        ),
    );

    // Then
    expect(error).toMatchObject({
        error: {
            code: 'provider_aborted',
            message: 'aborted [REDACTED_CREDENTIAL]',
            retryable: false,
        },
    });
});

it('maps retryable Anthropic rate-limit failures without leaking the API key', async () => {
    // Given
    const provider = createAnthropicMessagesProvider({
        credentialResolver: createStaticProviderCredentialResolver([
            anthropicCredential('anthropic', 'sk-ant-contract-secret'),
        ]),
        transport: {
            stream() {
                return throwingStream(
                    new AnthropicMessagesTransportError({
                        status: 429,
                        message: 'rate limited sk-ant-contract-secret',
                    }),
                );
            },
        },
    });

    // When
    const error = await captureError(
        collectChunks(
            provider.streamTurn(anthropicTurnRequest(), { attempt: 1, signal: new AbortController().signal }),
        ),
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
