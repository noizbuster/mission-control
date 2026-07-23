export type SseTransportRequest = {
    readonly endpoint: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
    readonly signal: AbortSignal;
};

export type SseStreamOptions = {
    readonly onError: (response: Response) => Promise<Error> | Error;
    readonly onInvalidJson: () => Error;
    /**
     * Maps failures while opening or reading the HTTP stream. The request signal is available to
     * callers so they can distinguish an intentional cancellation from a peer-side disconnect.
     */
    readonly onTransportError?: (error: unknown) => Error;
};

export async function* readSseStream(request: SseTransportRequest, options: SseStreamOptions): AsyncIterable<unknown> {
    let response: Response;
    try {
        response = await fetch(request.endpoint, {
            method: 'POST',
            headers: { ...request.headers, Accept: 'text/event-stream' },
            body: JSON.stringify(request.body),
            signal: request.signal,
        });
    } catch (error) {
        if (options.onTransportError !== undefined) {
            throw options.onTransportError(error);
        }
        throw error;
    }

    if (!response.ok) {
        throw await options.onError(response);
    }

    const reader = response.body?.getReader();
    if (reader === undefined) {
        throw new Error('SSE response body is null');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
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
    } catch (error) {
        if (options.onTransportError !== undefined) {
            throw options.onTransportError(error);
        }
        throw error;
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
