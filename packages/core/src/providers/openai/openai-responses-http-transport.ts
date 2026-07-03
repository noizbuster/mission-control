import {
    type OpenAIResponsesTransport,
    OpenAIResponsesTransportError,
    type OpenAIResponsesTransportRequest,
} from './openai-responses-transport.js';
import { parseSseFrames, readSseStream } from '../shared/sse-stream-transport.js';

export function createNodeOpenAIResponsesTransport(): OpenAIResponsesTransport {
    return {
        stream: (request) => streamOpenAIResponses(request),
    };
}

export async function* streamOpenAIResponses(input: OpenAIResponsesTransportRequest): AsyncIterable<unknown> {
    yield* readSseStream(input, {
        onError: async (response) =>
            new OpenAIResponsesTransportError({
                status: response.status,
                message: await response.text().catch(() => ''),
            }),
        onInvalidJson: () =>
            new OpenAIResponsesTransportError({
                kind: 'network',
                message: 'OpenAI SSE frame contained invalid JSON',
            }),
    });
}

export function parseOpenAIResponsesSseEvents(text: string): {
    readonly events: readonly unknown[];
    readonly remainder: string;
} {
    return parseSseFrames(text, () =>
        new OpenAIResponsesTransportError({
            kind: 'network',
            message: 'OpenAI SSE frame contained invalid JSON',
        }),
    );
}
