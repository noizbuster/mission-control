import type { AgentEventEnvelope, ProviderCredentialSummary } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createStaticProviderCredentialResolver, type ProviderCredentialResolver } from '../credential-resolver.js';
import { ProviderTurnRunner } from '../provider-turn-runner.js';
import { ProviderTurnError, type ProviderTurnRequest } from '../provider-turn-types.js';
import {
    createOpenAIResponsesProvider,
    type OpenAIResponsesTransport,
    OpenAIResponsesTransportError,
} from './openai-responses-provider.js';

describe('OpenAI Responses provider adapter errors', () => {
    it('maps auth failures without exposing raw credentials', async () => {
        // Given
        const provider = createOpenAIResponsesProvider({
            credentialResolver: createStaticProviderCredentialResolver([credential('openai', 'sk-test-secret')]),
            transport: throwingTransport(
                new OpenAIResponsesTransportError({ status: 401, message: 'bad sk-test-secret' }),
            ),
        });

        // When
        const error = await firstError(
            provider.streamTurn(turnRequest(), { attempt: 1, signal: new AbortController().signal }),
        );

        // Then
        expect(error.error).toMatchObject({ code: 'provider_auth_failed', retryable: false });
        expect(JSON.stringify(error)).not.toContain('sk-test-secret');
    });

    it('maps rate-limit context timeout and abort failures to typed provider errors', async () => {
        // Given
        const cases = [
            {
                transportError: new OpenAIResponsesTransportError({ status: 429, message: 'rate limited' }),
                expectedCode: 'provider_rate_limited',
                retryable: true,
            },
            {
                transportError: new OpenAIResponsesTransportError({
                    status: 400,
                    message: 'context_length_exceeded',
                    code: 'context_length_exceeded',
                }),
                expectedCode: 'provider_context_overflow',
                retryable: false,
            },
            {
                transportError: new OpenAIResponsesTransportError({ kind: 'timeout', message: 'request timed out' }),
                expectedCode: 'provider_timeout',
                retryable: true,
            },
            {
                transportError: new OpenAIResponsesTransportError({ kind: 'abort', message: 'request aborted' }),
                expectedCode: 'provider_aborted',
                retryable: false,
            },
        ] as const;

        for (const entry of cases) {
            const provider = createOpenAIResponsesProvider({
                credentialResolver: createStaticProviderCredentialResolver([credential('openai', 'sk-test-secret')]),
                transport: throwingTransport(entry.transportError),
            });

            // When
            const error = await firstError(
                provider.streamTurn(turnRequest(), { attempt: 1, signal: new AbortController().signal }),
            );

            // Then
            expect(error.error).toMatchObject({
                code: entry.expectedCode,
                retryable: entry.retryable,
            });
        }
    });

    it('redacts credentials from streamed OpenAI error events', async () => {
        // Given
        const secret = 'sk-test-secret';
        const cases = [
            {
                type: 'response.failed',
                sequence_number: 1,
                response: { id: 'resp_1', error: { code: 'rate_limit_exceeded', message: `rate limited ${secret}` } },
            },
            {
                type: 'error',
                sequence_number: 2,
                code: 'context_length_exceeded',
                message: `context overflow ${secret}`,
            },
        ];

        for (const event of cases) {
            const provider = createOpenAIResponsesProvider({
                credentialResolver: createStaticProviderCredentialResolver([credential('openai', secret)]),
                transport: transportFromEvents([event]),
            });

            // When
            const chunks = await collectChunks(
                provider.streamTurn(turnRequest(), { attempt: 1, signal: new AbortController().signal }),
            );

            // Then
            expect(chunks).toHaveLength(1);
            expect(chunks[0]).toMatchObject({ kind: 'response_failed' });
            expect(JSON.stringify(chunks)).not.toContain(secret);
        }
    });

    it('redacts credentials from setup errors before durable runner events', async () => {
        // Given
        const secret = 'sk-test-secret';
        const envelopes: AgentEventEnvelope[] = [];
        const provider = createOpenAIResponsesProvider({
            credentialResolver: throwingResolver(secret),
            transport: transportFromEvents([]),
        });
        const runner = new ProviderTurnRunner({
            provider,
            retryLimit: 0,
            now: () => '2026-06-09T00:00:00.000Z',
        });

        // When
        const result = await runner.runTurn({
            ...turnRequest(),
            startSequence: 0,
            onEnvelope: (envelope) => {
                envelopes.push(envelope);
            },
        });

        // Then
        const serialized = JSON.stringify({ result, envelopes });
        expect(result).toMatchObject({ status: 'failed', error: { code: 'unknown' } });
        expect(serialized).not.toContain(secret);
    });

    it('passes the provider abort signal to the HTTP transport', async () => {
        // Given
        const abortController = new AbortController();
        const seenSignals: AbortSignal[] = [];
        const provider = createOpenAIResponsesProvider({
            credentialResolver: createStaticProviderCredentialResolver([credential('openai', 'sk-test-secret')]),
            transport: {
                async *stream(request) {
                    seenSignals.push(request.signal);
                    yield { type: 'response.created', response: { id: 'resp_1' }, sequence_number: 1 };
                },
            },
        });

        // When
        await firstChunk(provider.streamTurn(turnRequest(), { attempt: 1, signal: abortController.signal }));
        abortController.abort();

        // Then
        expect(seenSignals[0]?.aborted).toBe(true);
    });
});

function credential(providerID: string, apiKey: string) {
    return {
        providerID,
        type: 'apiKey' as const,
        apiKey,
        createdAt: '2026-06-09T10:00:00.000Z',
        updatedAt: '2026-06-09T10:00:00.000Z',
    };
}

function turnRequest(): ProviderTurnRequest {
    return {
        requestId: 'request_openai',
        sessionId: 'session_openai',
        turnId: 'turn_openai',
        providerID: 'openai',
        modelID: 'gpt-5.5',
        messages: [{ role: 'user', content: 'say hello' }],
    };
}

function throwingResolver(secret: string): ProviderCredentialResolver {
    return {
        async resolveProviderCredential() {
            return undefined;
        },
        async resolveRequiredProviderCredential() {
            throw new Error(`resolver exploded ${secret}`);
        },
        async summarizeProviderCredential(): Promise<ProviderCredentialSummary | undefined> {
            return undefined;
        },
        redactForOutput(text) {
            return text
                .split(secret)
                .join('[REDACTED_CREDENTIAL]')
                .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED_CREDENTIAL]');
        },
    };
}

function throwingTransport(error: OpenAIResponsesTransportError): OpenAIResponsesTransport {
    return {
        stream: () => rejectingIterable(error),
    };
}

function transportFromEvents(events: readonly unknown[]): OpenAIResponsesTransport {
    return {
        async *stream() {
            for (const event of events) {
                yield event;
            }
        },
    };
}

function rejectingIterable(error: OpenAIResponsesTransportError): AsyncIterable<unknown> {
    return {
        [Symbol.asyncIterator]() {
            return {
                next: () => Promise.reject(error),
            };
        },
    };
}

async function firstError(stream: AsyncIterable<unknown>): Promise<ProviderTurnError> {
    try {
        for await (const _chunk of stream) {
            break;
        }
    } catch (error) {
        if (error instanceof ProviderTurnError) {
            return error;
        }
        throw error;
    }
    throw new TypeError('expected provider stream to fail');
}

async function collectChunks(stream: AsyncIterable<unknown>): Promise<readonly unknown[]> {
    const chunks: unknown[] = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return chunks;
}

async function firstChunk(stream: AsyncIterable<unknown>): Promise<unknown> {
    for await (const chunk of stream) {
        return chunk;
    }
    throw new TypeError('expected provider stream to emit a chunk');
}
