import { z } from 'zod';
import { createStreamDecoder } from '../providers/stream-decoder.js';
import type { PythonChildProcess } from './eval-python-process-tree.js';
import type { EvalToolBridge } from './eval-tool-bridge.js';

const PythonKernelOutboundSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('ready') }),
    z.object({ type: z.literal('tool-call'), name: z.string(), args: z.unknown() }),
    z.object({
        type: z.literal('result'),
        ok: z.boolean(),
        output: z.string().optional(),
        error: z.string().optional(),
    }),
]);

export type PythonKernelOutbound = z.infer<typeof PythonKernelOutboundSchema>;

export type PythonKernelInbound =
    | { readonly type: 'run'; readonly code: string }
    | { readonly type: 'reset' }
    | {
          readonly type: 'tool-reply';
          readonly reply:
              | { readonly ok: true; readonly value: unknown }
              | { readonly ok: false; readonly error: string };
      };

export type PythonKernelParsedResult = {
    readonly ok: boolean;
    readonly output: string;
    readonly error: string | undefined;
};

export type PythonKernelRunSettlement =
    | { readonly kind: 'result'; readonly result: PythonKernelParsedResult }
    | { readonly kind: 'timed_out' }
    | { readonly kind: 'aborted' }
    | { readonly kind: 'exited' };

export type PythonProtocolSessionOptions = {
    readonly child: PythonChildProcess;
    readonly reader: PythonProtocolLineReader;
    readonly bridge: EvalToolBridge | undefined;
    readonly terminate: () => Promise<void>;
};

export interface PythonProtocolLineReader {
    readLine(): Promise<string | null>;
    stop(): void;
}

export function createPythonProtocolLineReader(stream: NodeJS.ReadableStream): PythonProtocolLineReader {
    const pending: Array<(line: string | null) => void> = [];
    const lines: string[] = [];
    const decoder = createStreamDecoder();
    let buffer = '';
    let ended = false;

    const emitLine = (line: string): void => {
        const waiter = pending.shift();
        if (waiter === undefined) {
            lines.push(line);
            return;
        }
        waiter(line);
    };
    const drainLines = (): void => {
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
            emitLine(buffer.slice(0, newlineIndex));
            buffer = buffer.slice(newlineIndex + 1);
            newlineIndex = buffer.indexOf('\n');
        }
    };
    const settleEnd = (): void => {
        ended = true;
        while (pending.length > 0) {
            pending.shift()?.(null);
        }
    };
    const onData = (chunk: Buffer | string): void => {
        buffer += decoder.decode(chunk);
        drainLines();
    };
    const onEnd = (): void => {
        buffer += decoder.flush();
        drainLines();
        if (buffer.length > 0) {
            emitLine(buffer);
            buffer = '';
        }
        settleEnd();
    };
    stream.on('data', onData);
    stream.on('end', onEnd);

    return {
        readLine: async () => {
            const line = lines.shift();
            if (line !== undefined) {
                return line;
            }
            if (ended) {
                return null;
            }
            return await new Promise<string | null>((resolve) => pending.push(resolve));
        },
        stop: () => {
            stream.removeListener('data', onData);
            stream.removeListener('end', onEnd);
            lines.length = 0;
            buffer = '';
            settleEnd();
        },
    };
}

export function parsePythonKernelOutbound(line: string): PythonKernelOutbound | undefined {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        return undefined;
    }
    const parsed = PythonKernelOutboundSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

export function encodePythonKernelInbound(message: PythonKernelInbound): string {
    return `${JSON.stringify(message)}\n`;
}

export class PythonProtocolSession {
    readonly #child: PythonChildProcess;
    readonly #reader: PythonProtocolLineReader;
    readonly #bridge: EvalToolBridge | undefined;
    readonly #terminate: () => Promise<void>;

    constructor(options: PythonProtocolSessionOptions) {
        this.#child = options.child;
        this.#reader = options.reader;
        this.#bridge = options.bridge;
        this.#terminate = options.terminate;
    }

    async readMessage(): Promise<PythonKernelOutbound | null> {
        const line = await this.#reader.readLine();
        return line === null ? null : (parsePythonKernelOutbound(line) ?? null);
    }

    stop(): void {
        this.#reader.stop();
    }

    async request(
        message: PythonKernelInbound,
        timeoutMs: number,
        signal: AbortSignal | undefined,
    ): Promise<PythonKernelRunSettlement> {
        const lifecycle = createDeferred<PythonKernelRunSettlement>();
        let stopping = false;
        const stop = (settlement: PythonKernelRunSettlement): void => {
            if (stopping) {
                return;
            }
            stopping = true;
            void this.#terminate().then(() => lifecycle.resolve(settlement), lifecycle.reject);
        };
        const timer = setTimeout(() => stop({ kind: 'timed_out' }), timeoutMs);
        const onAbort = (): void => stop({ kind: 'aborted' });
        if (signal !== undefined) {
            if (signal.aborted) {
                onAbort();
            } else {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        }
        if (!stopping) {
            this.#child.stdin.write(encodePythonKernelInbound(message));
        }

        try {
            return await Promise.race([this.#pumpResult(), lifecycle.promise]);
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }
    }

    async #pumpResult(): Promise<PythonKernelRunSettlement> {
        while (true) {
            const parsed = await this.readMessage();
            if (parsed === null) {
                await this.#terminate();
                return { kind: 'exited' };
            }
            if (parsed.type === 'ready') {
                continue;
            }
            if (parsed.type === 'tool-call') {
                await this.#serviceToolCall(parsed.name, parsed.args);
                continue;
            }
            return {
                kind: 'result',
                result: {
                    ok: parsed.ok,
                    output: parsed.output ?? '',
                    error: parsed.error,
                },
            };
        }
    }

    async #serviceToolCall(name: string, args: unknown): Promise<void> {
        let reply: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };
        if (this.#bridge === undefined) {
            reply = { ok: false, error: `eval tool bridge unavailable for call: ${name}` };
        } else {
            try {
                reply = { ok: true, value: await this.#bridge.handleToolCall(name, args) };
            } catch (error) {
                reply = { ok: false, error: messageOf(error) };
            }
        }
        this.#child.stdin.write(encodePythonKernelInbound({ type: 'tool-reply', reply }));
    }
}

type Deferred<T> = {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
    readonly reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
    let resolvePromise: ((value: T) => void) | undefined;
    let rejectPromise: ((error: unknown) => void) | undefined;
    const promise = new Promise<T>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    if (resolvePromise === undefined || rejectPromise === undefined) {
        throw new Error('python protocol deferred initialization failed');
    }
    return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
