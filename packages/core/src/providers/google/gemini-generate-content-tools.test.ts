import { describe, expect, it } from 'vitest';
import { createStaticProviderCredentialResolver } from '../credential-resolver.js';
import {
    createGeminiGenerateContentProvider,
    type GeminiGenerateContentTransportRequest,
} from './gemini-generate-content-provider.js';
import {
    captureError,
    collectChunks,
    geminiCredential,
    geminiTurnRequest,
    searchToolDefinition,
    transportFromEvents,
    transportFromTurnEvents,
} from './gemini-generate-content-test-support.js';

describe('Gemini GenerateContent function calling', () => {
    it('maps functionCall parts to provider-neutral tool calls and transcript metadata', async () => {
        // Given
        const provider = createGeminiGenerateContentProvider({
            credentialResolver: createStaticProviderCredentialResolver([
                geminiCredential('google', 'sk-gemini-test-secret'),
            ]),
            transport: transportFromEvents(
                [],
                [
                    {
                        responseId: 'resp_tools',
                        candidates: [
                            {
                                index: 0,
                                content: {
                                    role: 'model',
                                    parts: [
                                        { text: 'need search' },
                                        {
                                            functionCall: {
                                                id: 'call_search',
                                                name: 'repo_search',
                                                args: { query: 'TODO' },
                                            },
                                        },
                                    ],
                                },
                                finishReason: 'STOP',
                            },
                        ],
                        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
                    },
                ],
            ),
        });

        // When
        const chunks = await collectChunks(
            provider.streamTurn(geminiTurnRequest(), { attempt: 1, signal: new AbortController().signal }),
        );

        // Then
        expect(chunks).toContainEqual({
            kind: 'tool_call_delta',
            requestId: 'request_gemini',
            sequence: 2,
            sourceEventType: 'candidate.part.functionCall',
            providerResponseId: 'resp_tools',
            toolCallId: 'call_search',
            providerCallId: 'call_search',
            providerItemId: '0:1',
            argumentsDelta: '{"query":"TODO"}',
        });
        expect(chunks).toContainEqual({
            kind: 'tool_call_completed',
            requestId: 'request_gemini',
            sequence: 3,
            sourceEventType: 'candidate.part.functionCall',
            providerResponseId: 'resp_tools',
            toolCall: {
                toolCallId: 'call_search',
                toolName: 'repo_search',
                argumentsJson: '{"query":"TODO"}',
                providerCallId: 'call_search',
                providerItemId: '0:1',
            },
        });
        expect(chunks).toContainEqual(
            expect.objectContaining({
                kind: 'response_completed',
                finishReason: 'tool_calls',
                message: expect.objectContaining({
                    content: 'need search',
                    toolCallIds: ['call_search'],
                    providerToolCalls: [
                        {
                            providerID: 'google',
                            toolCallId: 'call_search',
                            providerCallId: 'call_search',
                            providerItemId: '0:1',
                            toolName: 'repo_search',
                            argumentsJson: '{"query":"TODO"}',
                        },
                    ],
                }),
            }),
        );
    });

    it('sends model functionCall and user functionResponse parts for continuation', async () => {
        // Given
        const requests: GeminiGenerateContentTransportRequest[] = [];
        const provider = createGeminiGenerateContentProvider({
            credentialResolver: createStaticProviderCredentialResolver([
                geminiCredential('google', 'sk-gemini-test-secret'),
            ]),
            transport: transportFromTurnEvents(requests, [
                [
                    {
                        responseId: 'resp_empty',
                        candidates: [{ index: 0, content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
                    },
                ],
                [
                    {
                        responseId: 'resp_final',
                        candidates: [
                            {
                                index: 0,
                                content: { role: 'model', parts: [{ text: 'Found TODO entries' }] },
                                finishReason: 'STOP',
                            },
                        ],
                        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
                    },
                ],
            ]),
        });

        // When
        await collectChunks(
            provider.streamTurn(geminiTurnRequest({ tools: [searchToolDefinition()] }), {
                attempt: 1,
                signal: new AbortController().signal,
            }),
        );
        const continuationChunks = await collectChunks(
            provider.streamTurn(
                geminiTurnRequest({
                    requestId: 'request_gemini_continuation',
                    messages: [
                        { role: 'user', content: 'search TODO' },
                        {
                            role: 'assistant',
                            content: 'need search',
                            providerToolCalls: [
                                {
                                    providerID: 'google',
                                    providerCallId: 'call_search',
                                    providerItemId: '0:1',
                                    toolCallId: 'call_search',
                                    toolName: 'repo_search',
                                    argumentsJson: '{"query":"TODO"}',
                                },
                            ],
                        },
                        { role: 'tool', toolCallId: 'call_search', status: 'completed', output: 'TODO entries' },
                    ],
                    tools: [searchToolDefinition()],
                }),
                { attempt: 1, signal: new AbortController().signal },
            ),
        );

        // Then
        expect(requests[1]?.body.contents).toEqual([
            { role: 'user', parts: [{ text: 'search TODO' }] },
            {
                role: 'model',
                parts: [
                    { text: 'need search' },
                    {
                        functionCall: {
                            id: 'call_search',
                            name: 'repo_search',
                            args: { query: 'TODO' },
                        },
                    },
                ],
            },
            {
                role: 'user',
                parts: [
                    {
                        functionResponse: {
                            id: 'call_search',
                            name: 'repo_search',
                            response: { output: 'TODO entries' },
                        },
                    },
                ],
            },
        ]);
        expect(continuationChunks).toContainEqual(
            expect.objectContaining({
                kind: 'response_completed',
                message: expect.objectContaining({ content: 'Found TODO entries' }),
            }),
        );
    });

    it('fails malformed Gemini functionCall args before emitting a completed tool call', async () => {
        // Given
        const provider = createGeminiGenerateContentProvider({
            credentialResolver: createStaticProviderCredentialResolver([
                geminiCredential('google', 'sk-gemini-test-secret'),
            ]),
            transport: transportFromEvents(
                [],
                [
                    {
                        responseId: 'resp_malformed',
                        candidates: [
                            {
                                index: 0,
                                content: {
                                    role: 'model',
                                    parts: [
                                        { functionCall: { id: 'call_bad', name: 'repo_search', args: 'not-object' } },
                                    ],
                                },
                                finishReason: 'STOP',
                            },
                        ],
                    },
                ],
            ),
        });

        // When
        const error = await captureError(
            collectChunks(
                provider.streamTurn(geminiTurnRequest(), { attempt: 1, signal: new AbortController().signal }),
            ),
        );

        // Then
        expect(error).toMatchObject({
            error: {
                code: 'schema_invalid',
                retryable: false,
            },
        });
    });
});
