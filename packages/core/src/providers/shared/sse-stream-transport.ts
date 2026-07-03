export type SseTransportRequest = {
    readonly endpoint: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
    readonly signal: AbortSignal;
};

export async function* readSseStream(
    request: SseTransportRequest,
    options: {
        readonly onError: (response: Response) => Promise<Error> | Error;
        readonly onInvalidJson: () => Error;
    },
): AsyncIterable<unknown> {
    const response = await fetch(request.endpoint, {
        method: 'POST',
        headers: { ...request.headers, Accept: 'text/event-stream' },
        body: JSON.stringify(request.body),
        signal: request.signal,
    });

    if (!response.ok) {
        throw await options.onError(response);
    }

    const reader = response.body?.getReader();
    if (reader === undefined) {
        throw new Error('SSE response body is null');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const consumed = parseSseFrames(buffer, options.onInvalidJson);
        buffer = consumed.remainder;
        for (const event of consumed.events) {
            yield event;
        }
    }

    buffer += decoder.decode();
    const final = parseSseFrames(`${buffer}\n\n`, options.onInvalidJson);
    for (const event of final.events) {
        yield event;
    }
}

export function parseSseFrames(
    text: string,
    onInvalidJson: () => Error,
): {
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
        const event = parseSseFrame(frame, onInvalidJson);
        if (event !== undefined) {
            events.push(event);
        }
    }
}

function parseSseFrame(frame: string, onInvalidJson: () => Error): unknown | undefined {
    const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trimStart())
        .join('\n');
    if (data.length === 0 || data === '[DONE]') {
        return undefined;
    }
    try {
        return JSON.parse(data) as unknown;
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw onInvalidJson();
        }
        throw error;
    }
}
