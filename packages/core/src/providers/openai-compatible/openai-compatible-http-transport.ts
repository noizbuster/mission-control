import { retryAfterMsFromResponse } from '../shared/retry-after';
import { parseSseFrames, readSseStream } from '../shared/sse-stream-transport';
import {
    type OpenAICompatibleTransport,
    OpenAICompatibleTransportError,
    type OpenAICompatibleTransportRequest,
} from './openai-compatible-transport';

export function createNodeOpenAICompatibleTransport(): OpenAICompatibleTransport {
    return {
        stream: (request) => streamOpenAICompatibleChatCompletions(request),
    };
}

export async function* streamOpenAICompatibleChatCompletions(
    input: OpenAICompatibleTransportRequest,
): AsyncIterable<unknown> {
    yield* readSseStream(input, {
        onError: async (response) => {
            const retryAfterMs = retryAfterMsFromResponse(response);
            return new OpenAICompatibleTransportError({
                status: response.status,
                message: await response.text().catch(() => ''),
                ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            });
        },
        onInvalidJson: () =>
            new OpenAICompatibleTransportError({
                kind: 'network',
                message: 'OpenAI-compatible SSE frame contained invalid JSON',
            }),
        onTransportError: (error) =>
            new OpenAICompatibleTransportError({
                // A local cancellation is terminal; an AbortError without our signal being
                // aborted is a peer-side stream failure and must enter the retry path.
                kind: input.signal.aborted ? 'abort' : 'network',
                message: error instanceof Error ? error.message : String(error),
            }),
    });
}

export function parseOpenAICompatibleSseEvents(text: string): {
    readonly events: readonly unknown[];
    readonly remainder: string;
} {
    return parseSseFrames(
        text,
        () =>
            new OpenAICompatibleTransportError({
                kind: 'network',
                message: 'OpenAI-compatible SSE frame contained invalid JSON',
            }),
    );
}
