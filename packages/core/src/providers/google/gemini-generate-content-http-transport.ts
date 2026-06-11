import {
    type GeminiGenerateContentTransport,
    GeminiGenerateContentTransportError,
    type GeminiGenerateContentTransportRequest,
} from './gemini-generate-content-transport.js';

const ERROR_FIELD = 'error';
const STATUS_FIELD = 'status';
const MESSAGE_FIELD = 'message';

import { Buffer } from 'node:buffer';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

export function createNodeGeminiGenerateContentTransport(): GeminiGenerateContentTransport {
    return {
        stream: (request) => streamGeminiGenerateContent(request),
    };
}

export async function* streamGeminiGenerateContent(
    input: GeminiGenerateContentTransportRequest,
): AsyncIterable<unknown> {
    const response = await openGeminiResponse(input);
    if ((response.statusCode ?? 0) >= 400) {
        throw await transportErrorFromResponse(response);
    }

    let buffer = '';
    for await (const chunk of response) {
        buffer += chunkToText(chunk);
        const consumed = parseGeminiGenerateContentSseEvents(buffer);
        buffer = consumed.remainder;
        for (const event of consumed.events) {
            yield event;
        }
    }

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

function openGeminiResponse(input: GeminiGenerateContentTransportRequest): Promise<IncomingMessage> {
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
                new GeminiGenerateContentTransportError({ kind: 'abort', message: 'Gemini request aborted' }),
            );
        };
        const fail = (error: Error) => {
            input.signal.removeEventListener('abort', abort);
            reject(
                error instanceof GeminiGenerateContentTransportError
                    ? error
                    : new GeminiGenerateContentTransportError({ kind: 'network', message: error.message }),
            );
        };
        request.on('error', fail);
        request.on('close', () => input.signal.removeEventListener('abort', abort));
        input.signal.addEventListener('abort', abort, { once: true });
        request.end(body);
    });
}

async function transportErrorFromResponse(response: IncomingMessage): Promise<GeminiGenerateContentTransportError> {
    const text = await readResponseText(response);
    const parsed = parseGoogleError(text);
    return new GeminiGenerateContentTransportError({
        ...(response.statusCode === undefined ? {} : { status: response.statusCode }),
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
            throw new GeminiGenerateContentTransportError({
                kind: 'network',
                message: 'Gemini SSE frame contained invalid JSON',
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null;
}
