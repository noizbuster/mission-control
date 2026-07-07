import { parseSseFrames, readSseStream } from '../shared/sse-stream-transport.js';
import {
    type AnthropicMessagesTransport,
    AnthropicMessagesTransportError,
    type AnthropicMessagesTransportRequest,
} from './anthropic-messages-transport.js';

export function createNodeAnthropicMessagesTransport(): AnthropicMessagesTransport {
    return {
        stream: (request) => streamAnthropicMessages(request),
    };
}

export async function* streamAnthropicMessages(input: AnthropicMessagesTransportRequest): AsyncIterable<unknown> {
    yield* readSseStream(input, {
        onError: async (response) =>
            new AnthropicMessagesTransportError({
                status: response.status,
                message: await response.text().catch(() => ''),
            }),
        onInvalidJson: () =>
            new AnthropicMessagesTransportError({
                kind: 'network',
                message: 'Anthropic SSE frame contained invalid JSON',
            }),
    });
}

export function parseAnthropicMessagesSseEvents(text: string): {
    readonly events: readonly unknown[];
    readonly remainder: string;
} {
    return parseSseFrames(
        text,
        () =>
            new AnthropicMessagesTransportError({
                kind: 'network',
                message: 'Anthropic SSE frame contained invalid JSON',
            }),
    );
}
