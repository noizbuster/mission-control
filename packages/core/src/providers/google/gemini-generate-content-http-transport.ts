import {
    type GeminiGenerateContentTransport,
    GeminiGenerateContentTransportError,
    type GeminiGenerateContentTransportRequest,
} from './gemini-generate-content-transport.js';

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
    const response = await fetch(input.endpoint, {
        method: 'POST',
        headers: { ...input.headers, Accept: 'text/event-stream' },
        body: JSON.stringify(input.body),
        signal: input.signal,
    });

    if (!response.ok) {
        throw await transportErrorFromResponse(response);
    }

    const reader = response.body?.getReader();
    if (reader === undefined) {
        throw new GeminiGenerateContentTransportError({ kind: 'network', message: 'response body is null' });
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const consumed = parseGeminiGenerateContentSseEvents(buffer);
        buffer = consumed.remainder;
        for (const event of consumed.events) {
            yield event;
        }
    }

    buffer += decoder.decode();
    const final = parseGeminiGenerateContentSseEvents(`${buffer}\n\n`);
    for (const event of final.events) {
        yield event;
    }
}

export function parseGeminiGenerateContentSseEvents(text: string): {
    readonly events: readonly unknown[];
    readonly remainder: string;
} {
    const normalized = text.replace(/\r\n/g, '\n');
    const events: unknown[] = [];
    let remainder = normalized;

    while (true) {
        const boundary = remainder.indexOf('\n\n');
        if (boundary === -1) {
            return { events, remainder };
        }
        const frame = remainder.slice(0, boundary);
        remainder = remainder.slice(boundary + 2);
        const event = parseSseFrame(frame);
        if (event !== undefined) {
            events.push(event);
        }
    }
}

async function transportErrorFromResponse(response: Response): Promise<GeminiGenerateContentTransportError> {
    const text = await response.text().catch(() => '');
    const parsed = parseGoogleError(text);
    return new GeminiGenerateContentTransportError({
        status: response.status,
        ...(parsed.code !== undefined ? { code: parsed.code } : {}),
        message: parsed.message ?? text,
    });
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

function parseSseFrame(frame: string): unknown | undefined {
    const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trimStart())
        .join('\n');
    if (data.length === 0 || data === '[DONE]') {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(data);
        return parsed;
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new GeminiGenerateContentTransportError({
                kind: 'network',
                message: 'Gemini SSE frame contained invalid JSON',
            });
        }
        throw error;
    }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null;
}
