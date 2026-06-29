import { describe, expect, it } from 'vitest';
import { createStaticProviderCredentialResolver } from '../credential-resolver.js';
import type { ProviderTurnRequest } from '../provider-turn-types.js';
import {
    createAnthropicMessagesProvider,
    type AnthropicMessagesTransportRequest,
} from './anthropic-messages-provider.js';
import { anthropicCredential, collectChunks, transportFromEvents } from './anthropic-messages-test-support.js';

const defaultModelID = 'claude-sonnet-4-6';

// Minimal valid Anthropic Messages SSE event sequence so the mapper can drain
// the captured transport request without throwing. The body shape is what we
// assert on; the stream content is irrelevant to the variant mapping.
const minimalTurnEvents = [
    { type: 'message_start', message: { id: 'msg_variant', type: 'message', role: 'assistant', content: [] } },
    { type: 'message_stop' },
] as const;

describe('Anthropic Messages provider variants', () => {
    it('maps thinking-high variant into Anthropic Messages request body', async () => {
        const requests = captureRequests();
        const provider = providerCapturing(requests);

        await collectChunks(
            provider.streamTurn(turnRequest({ variantID: 'thinking-high' }), {
                attempt: 1,
                signal: new AbortController().signal,
            }),
        );

        const body = requests[0]?.body;
        expect(body).toMatchObject({
            model: defaultModelID,
            max_tokens: 33024,
            thinking: { type: 'enabled', budget_tokens: 32000 },
        });
        // Invariant: budget_tokens < max_tokens.
        expect(body?.max_tokens).toBeGreaterThan(body?.thinking?.budget_tokens ?? Number.POSITIVE_INFINITY);
    });

    it('maps thinking-low variant into Anthropic Messages request body', async () => {
        const requests = captureRequests();
        const provider = providerCapturing(requests);

        await collectChunks(
            provider.streamTurn(turnRequest({ variantID: 'thinking-low' }), {
                attempt: 1,
                signal: new AbortController().signal,
            }),
        );

        const body = requests[0]?.body;
        expect(body).toMatchObject({
            model: defaultModelID,
            max_tokens: 9024,
            thinking: { type: 'enabled', budget_tokens: 8000 },
        });
        // Invariant: budget_tokens < max_tokens.
        expect(body?.max_tokens).toBeGreaterThan(body?.thinking?.budget_tokens ?? Number.POSITIVE_INFINITY);
    });

    it('omits thinking and keeps default max_tokens for thinking-off variant', async () => {
        const requests = captureRequests();
        const provider = providerCapturing(requests);

        await collectChunks(
            provider.streamTurn(turnRequest({ variantID: 'thinking-off' }), {
                attempt: 1,
                signal: new AbortController().signal,
            }),
        );

        const body = requests[0]?.body;
        expect(hasOwn(body, 'thinking')).toBe(false);
        expect(body?.max_tokens).toBe(4096);
    });

    it('omits thinking and keeps default max_tokens when no variant is selected', async () => {
        const requests = captureRequests();
        const provider = providerCapturing(requests);

        await collectChunks(provider.streamTurn(turnRequest(), { attempt: 1, signal: new AbortController().signal }));

        const body = requests[0]?.body;
        expect(hasOwn(body, 'thinking')).toBe(false);
        expect(body?.max_tokens).toBe(4096);
    });

    it('silently drops stale thinking variant for a model without configured variants', async () => {
        const requests = captureRequests();
        const provider = providerCapturing(requests);

        await collectChunks(
            provider.streamTurn(
                turnRequest({ modelID: 'claude-3-5-sonnet-20241022', variantID: 'thinking-high' }),
                { attempt: 1, signal: new AbortController().signal },
            ),
        );

        const body = requests[0]?.body;
        expect(body).toMatchObject({ model: 'claude-3-5-sonnet-20241022' });
        expect(hasOwn(body, 'thinking')).toBe(false);
        expect(body?.max_tokens).toBe(4096);
    });

    it('preserves the budget_tokens < max_tokens invariant for every thinking variant', async () => {
        for (const variantID of ['thinking-low', 'thinking-medium', 'thinking-high'] as const) {
            const requests = captureRequests();
            const provider = providerCapturing(requests);

            await collectChunks(
                provider.streamTurn(turnRequest({ variantID }), { attempt: 1, signal: new AbortController().signal }),
            );

            const body = requests[0]?.body;
            const thinking = body?.thinking;
            if (thinking === undefined) {
                throw new Error(`expected thinking config for variant ${variantID}`);
            }
            expect(body?.max_tokens).toBeGreaterThan(thinking.budget_tokens);
        }
    });
});

function captureRequests(): AnthropicMessagesTransportRequest[] {
    return [];
}

function providerCapturing(requests: AnthropicMessagesTransportRequest[]) {
    return createAnthropicMessagesProvider({
        credentialResolver: createStaticProviderCredentialResolver([
            anthropicCredential('anthropic', 'sk-ant-test-secret'),
        ]),
        transport: transportFromEvents(requests, [...minimalTurnEvents]),
    });
}

function turnRequest(input: { readonly modelID?: string; readonly variantID?: string } = {}): ProviderTurnRequest {
    return {
        requestId: 'request_anthropic',
        sessionId: 'session_anthropic',
        turnId: 'turn_anthropic',
        providerID: 'anthropic',
        modelID: input.modelID ?? defaultModelID,
        ...(input.variantID !== undefined ? { variantID: input.variantID } : {}),
        messages: [{ role: 'user', content: 'say hello' }],
    };
}

function hasOwn(value: object | undefined, key: string): boolean {
    return value !== undefined && Object.hasOwn(value, key);
}
