import { describe, expect, it } from 'vitest';
import { createStaticProviderCredentialResolver } from '../credential-resolver.js';
import {
    createOpenAICompatibleProvider,
    OPENAI_COMPATIBLE_PROVIDER_SPECS,
    OpenAICompatibleTransportError,
    type OpenAICompatibleTransportRequest,
} from './openai-compatible-provider.js';
import {
    collectChunks,
    createProviderContext,
    credential,
    readToolDefinition,
    transportFromTurns,
    turnRequest,
} from './openai-compatible-test-support.js';

const compatibleProviderCases = OPENAI_COMPATIBLE_PROVIDER_SPECS.map(
    (spec) => [spec.providerID, spec.endpoint] as const,
);

describe('OpenAI-compatible provider adapter family', () => {
    it('declares only provider specs with endpoint proof for the compatible adapter family', () => {
        expect(OPENAI_COMPATIBLE_PROVIDER_SPECS.map((spec) => [spec.providerID, spec.endpoint])).toEqual([
            ['openrouter', 'https://openrouter.ai/api/v1/chat/completions'],
            ['groq', 'https://api.groq.com/openai/v1/chat/completions'],
            ['deepseek', 'https://api.deepseek.com/chat/completions'],
            ['mistral', 'https://api.mistral.ai/v1/chat/completions'],
            ['zai-coding-plan', 'https://api.z.ai/api/coding/paas/v4/chat/completions'],
        ]);
    });

    it.each(
        compatibleProviderCases,
    )('sends Chat Completions tools through %s and maps streamed tool-result continuation', async (providerID, endpoint) => {
        // Given
        const requests: OpenAICompatibleTransportRequest[] = [];
        const apiKey = `sk-${providerID}-secret`;
        const provider = createOpenAICompatibleProvider({
            credentialResolver: createStaticProviderCredentialResolver([credential(providerID, apiKey)]),
            transport: transportFromTurns(requests, [
                [
                    {
                        id: 'chatcmpl_tool',
                        choices: [
                            {
                                index: 0,
                                delta: {
                                    role: 'assistant',
                                    tool_calls: [
                                        {
                                            index: 0,
                                            id: 'call_read',
                                            type: 'function',
                                            function: {
                                                name: 'repo_read',
                                                arguments: '{"path":"README.md"}',
                                            },
                                        },
                                    ],
                                },
                                finish_reason: null,
                            },
                        ],
                    },
                    {
                        id: 'chatcmpl_tool',
                        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                    },
                ],
                [
                    {
                        id: 'chatcmpl_final',
                        choices: [{ index: 0, delta: { content: 'README says hello' }, finish_reason: null }],
                    },
                    {
                        id: 'chatcmpl_final',
                        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
                    },
                ],
            ]),
        });

        // When
        const firstChunks = await collectChunks(
            provider.streamTurn(turnRequest({ providerID, tools: [readToolDefinition()] }), {
                attempt: 1,
                signal: new AbortController().signal,
            }),
        );
        const continuationChunks = await collectChunks(
            provider.streamTurn(
                turnRequest({
                    requestId: `request_${providerID}_continuation`,
                    providerID,
                    messages: [
                        { role: 'user', content: 'read README' },
                        {
                            role: 'assistant',
                            content: 'need README',
                            providerToolCalls: [
                                {
                                    providerID,
                                    providerCallId: 'call_read',
                                    toolCallId: 'call_read',
                                    toolName: 'repo_read',
                                    argumentsJson: '{"path":"README.md"}',
                                },
                            ],
                        },
                        { role: 'tool', toolCallId: 'call_read', status: 'completed', output: 'README contents' },
                    ],
                    tools: [readToolDefinition()],
                }),
                { attempt: 1, signal: new AbortController().signal },
            ),
        );

        // Then
        expect(requests[0]).toMatchObject({
            endpoint,
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: {
                model: providerID === 'openrouter' ? '~anthropic/claude-haiku-latest' : 'test-model',
                stream: true,
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'repo_read',
                            description: 'Read a file',
                            parameters: {
                                type: 'object',
                                properties: { path: { type: 'string' } },
                                required: ['path'],
                            },
                        },
                    },
                ],
            },
        });
        expect(firstChunks).toContainEqual(
            expect.objectContaining({
                kind: 'tool_call_completed',
                toolCall: {
                    toolCallId: 'call_read',
                    toolName: 'repo_read',
                    argumentsJson: '{"path":"README.md"}',
                    providerCallId: 'call_read',
                },
            }),
        );
        expect(requests[1]?.body.messages).toEqual([
            { role: 'user', content: 'read README' },
            {
                role: 'assistant',
                content: 'need README',
                tool_calls: [
                    {
                        id: 'call_read',
                        type: 'function',
                        function: {
                            name: 'repo_read',
                            arguments: '{"path":"README.md"}',
                        },
                    },
                ],
            },
            { role: 'tool', tool_call_id: 'call_read', content: 'README contents' },
        ]);
        expect(continuationChunks).toContainEqual(
            expect.objectContaining({
                kind: 'response_completed',
                providerResponseId: 'chatcmpl_final',
                message: expect.objectContaining({ content: 'README says hello' }),
                usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
            }),
        );
        expect(JSON.stringify(requests.map((request) => request.body))).not.toContain(apiKey);
        expect(JSON.stringify(continuationChunks)).not.toContain(apiKey);
    });

    it('rejects malformed streamed tool-call arguments before completing a tool call', async () => {
        // Given
        const provider = createOpenAICompatibleProvider({
            credentialResolver: createStaticProviderCredentialResolver([credential('deepseek', 'sk-deepseek-secret')]),
            transport: transportFromTurns(
                [],
                [
                    [
                        {
                            id: 'chatcmpl_bad_args',
                            choices: [
                                {
                                    index: 0,
                                    delta: {
                                        tool_calls: [
                                            {
                                                index: 0,
                                                id: 'call_bad',
                                                type: 'function',
                                                function: {
                                                    name: 'repo_read',
                                                    arguments: { path: 'README.md' },
                                                },
                                            },
                                        ],
                                    },
                                    finish_reason: 'tool_calls',
                                },
                            ],
                        },
                    ],
                ],
            ),
        });

        // When / Then
        await expect(
            collectChunks(provider.streamTurn(turnRequest({ providerID: 'deepseek' }), createProviderContext())),
        ).rejects.toMatchObject({
            error: {
                code: 'schema_invalid',
                retryable: false,
            },
        });
    });

    it.each(
        compatibleProviderCases,
    )('redacts %s provider auth failures without leaking the compatible provider token', async (providerID) => {
        // Given
        const apiKey = `sk-${providerID}-secret`;
        const provider = createOpenAICompatibleProvider({
            credentialResolver: createStaticProviderCredentialResolver([credential(providerID, apiKey)]),
            transport: {
                stream() {
                    throw new OpenAICompatibleTransportError({
                        status: 401,
                        message: `${providerID} rejected ${apiKey}`,
                    });
                },
            },
        });

        // When / Then
        await expect(
            collectChunks(provider.streamTurn(turnRequest({ providerID }), createProviderContext())),
        ).rejects.toMatchObject({
            error: {
                code: 'provider_auth_failed',
                message: `${providerID} rejected [REDACTED_CREDENTIAL]`,
                retryable: false,
            },
        });
    });
});
