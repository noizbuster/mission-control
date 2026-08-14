import { afterEach, describe, expect, it } from 'vitest';
import { streamOpenAICompatibleChatCompletions } from './openai-compatible-http-transport';
import { OpenAICompatibleTransportError } from './openai-compatible-transport';

const REQUEST = {
    endpoint: 'https://provider.test/v1/chat/completions',
    headers: { Authorization: 'Bearer test-key' },
    body: {
        model: 'test-model',
        messages: [{ role: 'user' as const, content: 'hello' }],
        stream: true as const,
    },
};

async function captureStreamError(stream: AsyncIterable<unknown>): Promise<unknown> {
    try {
        for await (const _event of stream) {
            // The mocked transports fail before emitting any event.
        }
    } catch (error) {
        return error;
    }
    throw new Error('expected stream to fail');
}

describe('OpenAI-compatible HTTP transport cancellation classification', () => {
    let originalFetch: typeof globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('treats an unsignalled AbortError while opening the stream as a retryable network failure', async () => {
        // Given
        originalFetch = globalThis.fetch;
        globalThis.fetch = (() =>
            Promise.reject(new DOMException('peer closed connection', 'AbortError'))) as typeof fetch;
        const controller = new AbortController();

        // When
        const error = await captureStreamError(
            streamOpenAICompatibleChatCompletions({ ...REQUEST, signal: controller.signal }),
        );

        // Then
        expect(error).toBeInstanceOf(OpenAICompatibleTransportError);
        expect(error).toMatchObject({ kind: 'network', message: 'peer closed connection' });
    });

    it('treats an unsignalled AbortError while reading the stream as a retryable network failure', async () => {
        // Given
        originalFetch = globalThis.fetch;
        globalThis.fetch = (() =>
            Promise.resolve(
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.error(new DOMException('peer reset stream', 'AbortError'));
                        },
                    }),
                ),
            )) as typeof fetch;
        const controller = new AbortController();

        // When
        const error = await captureStreamError(
            streamOpenAICompatibleChatCompletions({ ...REQUEST, signal: controller.signal }),
        );

        // Then
        expect(error).toBeInstanceOf(OpenAICompatibleTransportError);
        expect(error).toMatchObject({ kind: 'network', message: 'peer reset stream' });
    });

    it('keeps a caller-signalled AbortError terminal', async () => {
        // Given
        originalFetch = globalThis.fetch;
        globalThis.fetch = (() => Promise.reject(new DOMException('caller cancelled', 'AbortError'))) as typeof fetch;
        const controller = new AbortController();
        controller.abort();

        // When
        const error = await captureStreamError(
            streamOpenAICompatibleChatCompletions({ ...REQUEST, signal: controller.signal }),
        );

        // Then
        expect(error).toBeInstanceOf(OpenAICompatibleTransportError);
        expect(error).toMatchObject({ kind: 'abort', message: 'caller cancelled' });
    });

    it('stamps a numeric Retry-After onto the transport error for non-2xx responses', async () => {
        // Given
        originalFetch = globalThis.fetch;
        globalThis.fetch = (() =>
            Promise.resolve(
                new Response('{"error":{"message":"rate limited"}}', {
                    status: 429,
                    headers: { 'Retry-After': '12' },
                }),
            )) as typeof fetch;

        // When
        const error = await captureStreamError(
            streamOpenAICompatibleChatCompletions({ ...REQUEST, signal: new AbortController().signal }),
        );

        // Then
        expect(error).toBeInstanceOf(OpenAICompatibleTransportError);
        expect(error).toMatchObject({ status: 429, retryAfterMs: 12_000 });
    });
});
