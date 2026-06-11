import {
    type AnthropicMessagesTransport,
    AnthropicMessagesTransportError,
    type AnthropicMessagesTransportRequest,
} from './anthropic-messages-transport.js';
import { Buffer } from 'node:buffer';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

export function createNodeAnthropicMessagesTransport(): AnthropicMessagesTransport {
    return {
        stream: (request) => streamAnthropicMessages(request),
    };
}

export async function* streamAnthropicMessages(input: AnthropicMessagesTransportRequest): AsyncIterable<unknown> {
    const response = await openAnthropicResponse(input);
    if ((response.statusCode ?? 0) >= 400) {
        const message = await readResponseText(response);
        throw new AnthropicMessagesTransportError({
            ...(response.statusCode === undefined ? {} : { status: response.statusCode }),
            message,
        });
    }

    let buffer = '';
    for await (const chunk of response) {
        buffer += chunkToText(chunk);
        const consumed = parseAnthropicMessagesSseEvents(buffer);
        buffer = consumed.remainder;
        for (const event of consumed.events) {
            yield event;
        }
    }

    const final = parseAnthropicMessagesSseEvents(`${buffer}\n\n`);
    for (const event of final.events) {
        yield event;
    }
}

export function parseAnthropicMessagesSseEvents(text: string): {
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

function openAnthropicResponse(input: AnthropicMessagesTransportRequest): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
        const url = new URL(input.endpoint);
        const body = JSON.stringify(input.body);
        const request = httpsRequest(
            url,
            {
                method: 'POST',
                headers: {
                    ...input.headers,
                    Accept: 'text/event-stream',
                    'Content-Length': Buffer.byteLength(body).toString(),
                },
            },
            resolve,
        );
        const abort = () => {
            request.destroy(
                new AnthropicMessagesTransportError({ kind: 'abort', message: 'Anthropic request aborted' }),
            );
        };
        const fail = (error: Error) => {
            input.signal.removeEventListener('abort', abort);
            reject(
                error instanceof AnthropicMessagesTransportError
                    ? error
                    : new AnthropicMessagesTransportError({ kind: 'network', message: error.message }),
            );
        };
        request.on('error', fail);
        request.on('close', () => input.signal.removeEventListener('abort', abort));
        input.signal.addEventListener('abort', abort, { once: true });
        request.end(body);
    });
}

async function readResponseText(response: IncomingMessage): Promise<string> {
    let output = '';
    for await (const chunk of response) {
        output += chunkToText(chunk);
    }
    return output;
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
            throw new AnthropicMessagesTransportError({
                kind: 'network',
                message: 'Anthropic SSE frame contained invalid JSON',
            });
        }
        throw error;
    }
}

function chunkToText(chunk: unknown): string {
    if (typeof chunk === 'string') {
        return chunk;
    }
    if (Buffer.isBuffer(chunk)) {
        return chunk.toString('utf8');
    }
    return String(chunk);
}
