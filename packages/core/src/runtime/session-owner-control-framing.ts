import { z } from 'zod';
import type { Duplex } from 'node:stream';

export const SESSION_OWNER_CONTROL_MAX_FRAME_BYTES = 65_536;

export class SessionOwnerControlFrameError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SessionOwnerControlFrameError';
    }
}

export function encodeSessionOwnerControlFrame(value: unknown): Buffer {
    const frame = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    if (frame.byteLength > SESSION_OWNER_CONTROL_MAX_FRAME_BYTES) {
        throw new SessionOwnerControlFrameError('session owner control frame exceeds the byte limit');
    }
    return frame;
}

export function attachSessionOwnerControlFrameReader(input: {
    readonly socket: Duplex;
    readonly initialBytes?: Buffer;
    readonly onFrame: (value: unknown) => void | Promise<void>;
    readonly onError: (error: SessionOwnerControlFrameError) => void;
}): void {
    let buffered = input.initialBytes ?? Buffer.alloc(0);
    let reading = Promise.resolve();
    const consume = (chunk: Buffer): void => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.byteLength > SESSION_OWNER_CONTROL_MAX_FRAME_BYTES && buffered.indexOf(0x0a) < 0) {
            input.onError(new SessionOwnerControlFrameError('unterminated session owner control frame'));
            return;
        }
        let newline = buffered.indexOf(0x0a);
        while (newline >= 0) {
            const frame = buffered.subarray(0, newline);
            buffered = buffered.subarray(newline + 1);
            if (frame.byteLength === 0 || frame.byteLength + 1 > SESSION_OWNER_CONTROL_MAX_FRAME_BYTES) {
                input.onError(new SessionOwnerControlFrameError('invalid session owner control frame length'));
                return;
            }
            let value: unknown;
            try {
                value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame));
            } catch {
                input.onError(new SessionOwnerControlFrameError('session owner control frame is not valid UTF-8 JSON'));
                return;
            }
            reading = reading.then(() => input.onFrame(value)).catch(() => undefined);
            newline = buffered.indexOf(0x0a);
        }
    };
    input.socket.on('data', consume);
    if (buffered.byteLength > 0) consume(Buffer.alloc(0));
}

export function parseSessionOwnerControlFrame<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new SessionOwnerControlFrameError('session owner control frame violates the protocol');
    return parsed.data;
}
