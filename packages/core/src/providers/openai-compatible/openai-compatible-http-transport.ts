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
        onError: async (response) =>
            new OpenAICompatibleTransportError({
                status: response.status,
                message: await response.text().catch(() => ''),
            }),
        onInvalidJson: () =>
            new OpenAICompatibleTransportError({
                kind: 'network',
                message: 'OpenAI-compatible SSE frame contained invalid JSON',
            }),
        onFetchError: (error) => {
            if (input.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
                return new OpenAICompatibleTransportError({
                    kind: 'abort',
                    message: error instanceof Error ? error.message : String(error),
                });
            }
            return new OpenAICompatibleTransportError({
                kind: 'network',
                message: error instanceof Error ? error.message : String(error),
            });
        },
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
