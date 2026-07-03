import {
    type OpenAICompatibleTransport,
    OpenAICompatibleTransportError,
    type OpenAICompatibleTransportRequest,
} from './openai-compatible-transport.js';

export function createNodeOpenAICompatibleTransport(): OpenAICompatibleTransport {
    return {
        stream: (request) => streamOpenAICompatibleChatCompletions(request),
    };
}

export async function* streamOpenAICompatibleChatCompletions(
    input: OpenAICompatibleTransportRequest,
): AsyncIterable<unknown> {
    const response = await fetch(input.endpoint, {
        method: 'POST',
        headers: { ...input.headers, Accept: 'text/event-stream' },
        body: JSON.stringify(input.body),
        signal: input.signal,
    });

    if (!response.ok) {
        const message = await response.text().catch(() => '');
        throw new OpenAICompatibleTransportError({
            status: response.status,
            message,
        });
    }

    const reader = response.body?.getReader();
    if (reader === undefined) {
        throw new OpenAICompatibleTransportError({ kind: 'network', message: 'response body is null' });
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const consumed = parseOpenAICompatibleSseEvents(buffer);
        buffer = consumed.remainder;
        for (const event of consumed.events) {
            yield event;
        }
    }

    buffer += decoder.decode();
    const final = parseOpenAICompatibleSseEvents(`${buffer}\n\n`);
    for (const event of final.events) {
        yield event;
    }
}

export function parseOpenAICompatibleSseEvents(text: string): {
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
            throw new OpenAICompatibleTransportError({
                kind: 'network',
                message: 'OpenAI-compatible SSE frame contained invalid JSON',
            });
        }
        throw error;
    }
}
