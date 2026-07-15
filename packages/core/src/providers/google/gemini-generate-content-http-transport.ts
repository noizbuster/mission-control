import { parseSseFrames, readSseStream } from '../shared/sse-stream-transport';
import {
    type GeminiGenerateContentTransport,
    GeminiGenerateContentTransportError,
    type GeminiGenerateContentTransportRequest,
} from './gemini-generate-content-transport';

const ERROR_FIELD = 'error';
const STATUS_FIELD = 'status';
const MESSAGE_FIELD = 'message';

export function createNodeGeminiGenerateContentTransport(): GeminiGenerateContentTransport {
    return {
        stream: (request) => streamGeminiGenerateContent(request),
    };
}

export async function* streamGeminiGenerateContent(
    input: GeminiGenerateContentTransportRequest,
): AsyncIterable<unknown> {
    yield* readSseStream(input, {
        onError: async (response) => {
            const text = await response.text().catch(() => '');
            const parsed = parseGoogleError(text);
            return new GeminiGenerateContentTransportError({
                status: response.status,
                ...(parsed.code !== undefined ? { code: parsed.code } : {}),
                message: parsed.message ?? text,
            });
        },
        onInvalidJson: () =>
            new GeminiGenerateContentTransportError({
                kind: 'network',
                message: 'Gemini SSE frame contained invalid JSON',
            }),
    });
}

export function parseGeminiGenerateContentSseEvents(text: string): {
    readonly events: readonly unknown[];
    readonly remainder: string;
} {
    return parseSseFrames(
        text,
        () =>
            new GeminiGenerateContentTransportError({
                kind: 'network',
                message: 'Gemini SSE frame contained invalid JSON',
            }),
    );
}

function parseGoogleError(text: string): { readonly code?: string; readonly message?: string } {
    try {
        const parsed: unknown = JSON.parse(text);
        const errorRecord = isRecord(parsed) ? parsed[ERROR_FIELD] : undefined;
        if (isRecord(errorRecord)) {
            return {
                ...(typeof errorRecord[STATUS_FIELD] === 'string' ? { code: errorRecord[STATUS_FIELD] } : {}),
                ...(typeof errorRecord[MESSAGE_FIELD] === 'string' ? { message: errorRecord[MESSAGE_FIELD] } : {}),
            };
        }
    } catch (error) {
        if (error instanceof SyntaxError) {
            return {};
        }
        throw error;
    }
    return {};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null;
}
