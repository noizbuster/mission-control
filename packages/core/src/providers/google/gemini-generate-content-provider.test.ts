import { describe, expect, it } from 'vitest';
import { createStaticProviderCredentialResolver } from '../credential-resolver.js';
import {
    createGeminiGenerateContentProvider,
    GeminiGenerateContentTransportError,
    type GeminiGenerateContentTransportRequest,
} from './gemini-generate-content-provider.js';
import {
    captureError,
    collectChunks,
    geminiCredential,
    geminiTurnRequest,
    searchToolDefinition,
    throwingStream,
    transportFromEvents,
} from './gemini-generate-content-test-support.js';

describe('Gemini GenerateContent provider adapter', () => {
    it('streams text chunks and sends authenticated requests with function declarations', async () => {
        // Given
        const requests: GeminiGenerateContentTransportRequest[] = [];
        const provider = createGeminiGenerateContentProvider({
            credentialResolver: createStaticProviderCredentialResolver([
                geminiCredential('google', 'sk-gemini-test-secret'),
            ]),
            transport: transportFromEvents(requests, [
                {
                    responseId: 'resp_1',
                    candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hel' }] } }],
                    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
                },
                {
                    responseId: 'resp_1',
                    candidates: [
                        { index: 0, content: { role: 'model', parts: [{ text: 'lo' }] }, finishReason: 'STOP' },
                    ],
                    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
                },
            ]),
        });

        // When
        const chunks = await collectChunks(
            provider.streamTurn(geminiTurnRequest({ tools: [searchToolDefinition()] }), {
                attempt: 1,
                signal: new AbortController().signal,
            }),
        );

        // Then
        expect(requests[0]).toMatchObject({
            endpoint:
                'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse',
            headers: {
                'x-goog-api-key': 'sk-gemini-test-secret',
                'Content-Type': 'application/json',
            },
            body: {
                contents: [{ role: 'user', parts: [{ text: 'say hello' }] }],
                tools: [
                    {
                        functionDeclarations: [
                            {
                                name: 'repo_search',
                                description: 'Search repository files',
                                parameters: {
                                    type: 'object',
                                    properties: { query: { type: 'string' } },
                                    required: ['query'],
                                },
                            },
                        ],
                    },
                ],
            },
        });
        expect(chunks).toMatchObject([
            { kind: 'response_started', providerResponseId: 'resp_1' },
            { kind: 'text_delta', delta: 'hel' },
            { kind: 'text_delta', delta: 'lo' },
            { kind: 'response_completed', message: { content: 'hello' }, finishReason: 'stop' },
        ]);
        expect(chunks.at(-1)).toMatchObject({ usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } });
        expect(JSON.stringify(requests.map((request) => request.body))).not.toContain('sk-gemini-test-secret');
        expect(JSON.stringify(chunks)).not.toContain('sk-gemini-test-secret');
    });

    it('maps auth and abort failures without leaking the Gemini API key', async () => {
        // Given
        const authProvider = createGeminiGenerateContentProvider({
            credentialResolver: createStaticProviderCredentialResolver([
                geminiCredential('google', 'sk-gemini-test-secret'),
            ]),
            transport: {
                stream() {
                    return throwingStream(
                        new GeminiGenerateContentTransportError({
                            status: 401,
                            message: 'invalid key sk-gemini-test-secret',
                        }),
                    );
                },
            },
        });
        const abortProvider = createGeminiGenerateContentProvider({
            credentialResolver: createStaticProviderCredentialResolver([
                geminiCredential('google', 'sk-gemini-test-secret'),
            ]),
            transport: {
                stream() {
                    return throwingStream(
                        new GeminiGenerateContentTransportError({
                            kind: 'abort',
                            message: 'Gemini request aborted sk-gemini-test-secret',
                        }),
                    );
                },
            },
        });

        // When
        const authError = await captureError(
            collectChunks(
                authProvider.streamTurn(geminiTurnRequest(), { attempt: 1, signal: new AbortController().signal }),
            ),
        );
        const abortError = await captureError(
            collectChunks(
                abortProvider.streamTurn(geminiTurnRequest(), { attempt: 1, signal: new AbortController().signal }),
            ),
        );

        // Then
        expect(authError).toMatchObject({
            error: {
                code: 'provider_auth_failed',
                message: 'invalid key [REDACTED_CREDENTIAL]',
                retryable: false,
            },
        });
        expect(abortError).toMatchObject({
            error: {
                code: 'provider_aborted',
                message: 'Gemini request aborted [REDACTED_CREDENTIAL]',
                retryable: false,
            },
        });
        expect(JSON.stringify({ authError, abortError })).not.toContain('sk-gemini-test-secret');
    });
});
