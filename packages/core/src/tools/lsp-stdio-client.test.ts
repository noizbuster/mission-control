import { describe, expect, it } from 'vitest';
import { encodeLspMessage, LspMessageDecoder, type LspTransport, StdioLspClient } from './lsp-stdio-client.js';
import { ToolExecutionError } from './tool-registry-types.js';

const WORKSPACE_ROOT = '/workspace';
const SAMPLE_URI = 'file:///workspace/src/sample.ts';

// ---------------------------------------------------------------------------
// Mock transport: captures writes (decoded for assertion) and lets tests inject
// inbound bytes via feed()/emit() and close events via simulateClose(). No real
// process is spawned — every case is deterministic.
// ---------------------------------------------------------------------------

type WrittenMessage = {
    readonly jsonrpc: string;
    readonly id?: number;
    readonly method?: string;
    readonly params?: unknown;
    readonly result?: unknown;
    readonly error?: unknown;
};

type WrittenRequest = {
    readonly jsonrpc: string;
    readonly id: number;
    readonly method: string;
    readonly params?: unknown;
};

class MockLspTransport implements LspTransport {
    readonly messages: WrittenMessage[] = [];
    readonly killSignals: NodeJS.Signals[] = [];
    private readonly dataHandlers: Array<(chunk: Buffer) => void> = [];
    private readonly closeHandlers: Array<(exitCode: number | null) => void> = [];

    write(buffer: Buffer): void {
        const decoded = decodeFirst(buffer);
        if (decoded !== undefined) this.messages.push(decoded);
    }

    /** Push raw stdout bytes into the client (exercises the real decoder). */
    feed(chunk: Buffer): void {
        for (const handler of this.dataHandlers) handler(chunk);
    }

    /** Encode `message` via the real framer and feed it (exercises encode + decode together). */
    emit(message: WrittenMessage): void {
        this.feed(encodeLspMessage(message));
    }

    simulateClose(exitCode: number | null): void {
        for (const handler of this.closeHandlers) handler(exitCode);
    }

    onData(handler: (chunk: Buffer) => void): void {
        this.dataHandlers.push(handler);
    }

    onClose(handler: (exitCode: number | null) => void): void {
        this.closeHandlers.push(handler);
    }

    kill(signal?: NodeJS.Signals): void {
        this.killSignals.push(signal ?? 'SIGTERM');
    }
}

function decodeFirst(buffer: Buffer): WrittenMessage | undefined {
    const separatorIndex = buffer.indexOf('\r\n\r\n', 0, 'utf8');
    if (separatorIndex === -1) return undefined;
    try {
        const parsed = JSON.parse(buffer.subarray(separatorIndex + 4).toString('utf8'));
        if (parsed !== null && typeof parsed === 'object') return parsed as WrittenMessage;
    } catch {
        // malformed write — ignore
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Setup + helpers
// ---------------------------------------------------------------------------

function makeClient(options?: { readonly requestTimeoutMs?: number }): {
    readonly client: StdioLspClient;
    readonly transport: MockLspTransport;
} {
    const transport = new MockLspTransport();
    const client = new StdioLspClient(
        {
            command: 'typescript-language-server',
            args: ['--stdio'],
            workspaceRoot: WORKSPACE_ROOT,
            ...(options?.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
        },
        {
            createTransport: () => transport,
            resolveDocument: async () => ({ content: 'let x = 1\n', languageId: 'typescript' }),
        },
    );
    return { client, transport };
}

/** Drain queued microtasks so async client methods reach their first real await. */
function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

async function initializeClient(client: StdioLspClient, transport: MockLspTransport): Promise<void> {
    const initPromise = client.initialize();
    await flush();
    const request = requireLastRequest(transport.messages, 'initialize');
    transport.emit({ jsonrpc: '2.0', id: request.id, result: { capabilities: {} } });
    await initPromise;
}

function requestsFor(messages: readonly WrittenMessage[], method: string): readonly WrittenRequest[] {
    const out: WrittenRequest[] = [];
    for (const message of messages) {
        if (message.method === method && typeof message.id === 'number') {
            out.push({
                jsonrpc: message.jsonrpc,
                id: message.id,
                method: message.method,
                ...(message.params !== undefined ? { params: message.params } : {}),
            });
        }
    }
    return out;
}

function requireLastRequest(messages: readonly WrittenMessage[], method: string): WrittenRequest {
    const matches = requestsFor(messages, method);
    const last = matches[matches.length - 1];
    if (last === undefined) {
        throw new Error(`expected a "${method}" request to be sent`);
    }
    return last;
}

function findNotification(messages: readonly WrittenMessage[], method: string): WrittenMessage | undefined {
    return messages.find((message) => message.method === method && message.id === undefined);
}

function asToolError(error: unknown): ToolExecutionError {
    if (error instanceof ToolExecutionError) return error;
    throw new Error(`expected ToolExecutionError, got ${typeof error}`);
}

async function safeShutdown(client: StdioLspClient, transport: MockLspTransport): Promise<void> {
    // If the client is already closed (crash/abort test), shutdown is a no-op and writes nothing;
    // otherwise answer its shutdown request so shutdown() settles cleanly.
    const shutdownPromise = client.shutdown();
    await flush();
    const shutdownRequests = requestsFor(transport.messages, 'shutdown');
    const request = shutdownRequests[shutdownRequests.length - 1];
    if (request !== undefined && typeof request.id === 'number') {
        transport.emit({ jsonrpc: '2.0', id: request.id, result: null });
    }
    await shutdownPromise.catch(() => undefined);
}

// ===========================================================================
// Framing (pure encode/decode)
// ===========================================================================

describe('LSP Content-Length framing', () => {
    it('encodes a message as "Content-Length: N\\r\\n\\r\\n<json>"', () => {
        const frame = encodeLspMessage({ jsonrpc: '2.0', id: 7, method: 'ping' });
        const text = frame.toString('utf8');
        expect(text).toMatch(/^Content-Length: \d+\r\n\r\n/);
        const body = text.slice(text.indexOf('\r\n\r\n') + 4);
        expect(JSON.parse(body)).toEqual({ jsonrpc: '2.0', id: 7, method: 'ping' });
    });

    it('decodes a single frame back to the original message', () => {
        const original = { jsonrpc: '2.0', id: 3, method: 'hover', params: { line: 1 } };
        const frame = encodeLspMessage(original).toString('utf8');
        const decoded = JSON.parse(frame.slice(frame.indexOf('\r\n\r\n') + 4));
        expect(decoded).toEqual(original);
    });

    it('reassembles a frame split across two chunks', () => {
        const decoder = new LspMessageDecoder();
        const frame = encodeLspMessage({ jsonrpc: '2.0', method: 'note', params: { a: 1 } });
        const splitAt = Math.floor(frame.length / 2);
        expect(decoder.feed(frame.subarray(0, splitAt))).toHaveLength(0);
        const second = decoder.feed(frame.subarray(splitAt));
        expect(second).toHaveLength(1);
        expect(second[0]).toEqual({ jsonrpc: '2.0', method: 'note', params: { a: 1 } });
    });

    it('yields multiple messages when several frames coalesce into one chunk', () => {
        const decoder = new LspMessageDecoder();
        const combined = Buffer.concat([
            encodeLspMessage({ jsonrpc: '2.0', method: 'one' }),
            encodeLspMessage({ jsonrpc: '2.0', method: 'two' }),
            encodeLspMessage({ jsonrpc: '2.0', method: 'three' }),
        ]);
        const messages = decoder.feed(combined);
        expect(messages.map((message) => (message as { method: string }).method)).toEqual(['one', 'two', 'three']);
    });

    it('drops a malformed header block (missing Content-Length) and resyncs onto the next frame', () => {
        const decoder = new LspMessageDecoder();
        const junk = Buffer.from('Garbage: yes\r\n\r\n', 'utf8');
        const good = encodeLspMessage({ jsonrpc: '2.0', method: 'recover' });
        const messages = decoder.feed(Buffer.concat([junk, good]));
        expect(messages.map((message) => (message as { method: string }).method)).toEqual(['recover']);
    });
});

// ===========================================================================
// StdioLspClient (mock transport)
// ===========================================================================

describe('StdioLspClient', () => {
    it('initialize() sends an initialize request advertising the workspace root, then an initialized notification', async () => {
        const { client, transport } = makeClient();
        try {
            const initPromise = client.initialize();
            await flush();
            const request = requireLastRequest(transport.messages, 'initialize');
            expect(request.params).toMatchObject({
                rootUri: `file://${WORKSPACE_ROOT}`,
                workspaceFolders: [{ uri: `file://${WORKSPACE_ROOT}`, name: 'workspace' }],
            });
            transport.emit({ jsonrpc: '2.0', id: request.id, result: { capabilities: {} } });
            await initPromise;
            expect(findNotification(transport.messages, 'initialized')).toBeDefined();
        } finally {
            await safeShutdown(client, transport);
        }
    });

    it('hover() opens the document then returns the flattened MarkupContent hover', async () => {
        const { client, transport } = makeClient();
        try {
            await initializeClient(client, transport);
            const hoverPromise = client.hover(SAMPLE_URI, 1, 2);
            await flush();
            expect(findNotification(transport.messages, 'textDocument/didOpen')).toBeDefined();
            const request = requireLastRequest(transport.messages, 'textDocument/hover');
            expect(request.params).toEqual({
                textDocument: { uri: SAMPLE_URI },
                position: { line: 1, character: 2 },
            });
            transport.emit({
                jsonrpc: '2.0',
                id: request.id,
                result: { contents: { kind: 'markdown', value: '```typescript\nconst x: number\n```' } },
            });
            expect(await hoverPromise).toEqual({ contents: '```typescript\nconst x: number\n```' });
        } finally {
            await safeShutdown(client, transport);
        }
    });

    it('hover() flattens a MarkedString[] into a single joined string', async () => {
        const { client, transport } = makeClient();
        try {
            await initializeClient(client, transport);
            const hoverPromise = client.hover(SAMPLE_URI, 0, 0);
            await flush();
            const request = requireLastRequest(transport.messages, 'textDocument/hover');
            transport.emit({
                jsonrpc: '2.0',
                id: request.id,
                result: { contents: ['plain text', { language: 'typescript', value: 'const x' }] },
            });
            expect(await hoverPromise).toEqual({ contents: 'plain text\n\nconst x' });
        } finally {
            await safeShutdown(client, transport);
        }
    });

    it('definition() maps a Location[] result into flat 0-indexed locations', async () => {
        const { client, transport } = makeClient();
        try {
            await initializeClient(client, transport);
            const definitionPromise = client.definition(SAMPLE_URI, 4, 5);
            await flush();
            const request = requireLastRequest(transport.messages, 'textDocument/definition');
            transport.emit({
                jsonrpc: '2.0',
                id: request.id,
                result: [
                    {
                        uri: 'file:///workspace/src/other.ts',
                        range: { start: { line: 9, character: 2 }, end: { line: 9, character: 8 } },
                    },
                ],
            });
            expect(await definitionPromise).toEqual([{ uri: 'file:///workspace/src/other.ts', line: 9, character: 2 }]);
        } finally {
            await safeShutdown(client, transport);
        }
    });

    it('definition() maps a LocationLink[] result via targetUri/targetRange', async () => {
        const { client, transport } = makeClient();
        try {
            await initializeClient(client, transport);
            const definitionPromise = client.definition(SAMPLE_URI, 0, 0);
            await flush();
            const request = requireLastRequest(transport.messages, 'textDocument/definition');
            transport.emit({
                jsonrpc: '2.0',
                id: request.id,
                result: [
                    {
                        targetUri: 'file:///workspace/src/linked.ts',
                        targetRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
                    },
                ],
            });
            expect(await definitionPromise).toEqual([
                { uri: 'file:///workspace/src/linked.ts', line: 1, character: 0 },
            ]);
        } finally {
            await safeShutdown(client, transport);
        }
    });

    it('diagnostics() returns cached diagnostics mapped from a publishDiagnostics notification', async () => {
        const { client, transport } = makeClient();
        try {
            await initializeClient(client, transport);
            transport.emit({
                jsonrpc: '2.0',
                method: 'textDocument/publishDiagnostics',
                params: {
                    uri: SAMPLE_URI,
                    diagnostics: [
                        {
                            range: { start: { line: 3, character: 5 }, end: { line: 3, character: 9 } },
                            severity: 1,
                            message: 'Type mismatch',
                            source: 'tsserver',
                        },
                        {
                            range: { start: { line: 7, character: 0 }, end: { line: 7, character: 1 } },
                            severity: 2,
                            message: 'Unused variable',
                        },
                    ],
                },
            });
            const diagnostics = await client.diagnostics(SAMPLE_URI);
            expect(diagnostics).toEqual([
                { message: 'Type mismatch', severity: 'error', line: 3, character: 5, source: 'tsserver' },
                { message: 'Unused variable', severity: 'warning', line: 7, character: 0 },
            ]);
            expect(await client.diagnostics('file:///workspace/src/other.ts')).toEqual([]);
        } finally {
            await safeShutdown(client, transport);
        }
    });

    it('correlates responses to requests by id, even when answers arrive out of order', async () => {
        const { client, transport } = makeClient();
        try {
            await initializeClient(client, transport);
            const firstHover = client.hover(SAMPLE_URI, 1, 1);
            const secondHover = client.hover(SAMPLE_URI, 2, 2);
            await flush();
            const hoverRequests = requestsFor(transport.messages, 'textDocument/hover');
            const firstId = hoverRequests[0]?.id;
            const secondId = hoverRequests[1]?.id;
            if (firstId === undefined || secondId === undefined) {
                throw new Error('expected two hover requests');
            }
            // Answer the second request first to prove correlation is id-based, not order-based.
            transport.emit({ jsonrpc: '2.0', id: secondId, result: { contents: 'second' } });
            transport.emit({ jsonrpc: '2.0', id: firstId, result: { contents: 'first' } });
            const [first, second] = await Promise.all([firstHover, secondHover]);
            expect(first).toEqual({ contents: 'first' });
            expect(second).toEqual({ contents: 'second' });
        } finally {
            await safeShutdown(client, transport);
        }
    });

    it('rejects a request with a retryable ToolExecutionError after the configured timeout', async () => {
        const { client, transport } = makeClient({ requestTimeoutMs: 50 });
        try {
            await initializeClient(client, transport);
            const startedAt = Date.now();
            // No response is emitted; the request must time out.
            await expect(client.hover(SAMPLE_URI, 0, 0)).rejects.toThrow(/timed out after 50ms/);
            expect(Date.now() - startedAt).toBeLessThan(2000);
            // The timed-out request is cleared from pending, so a fresh request still works.
            const hoverPromise = client.hover(SAMPLE_URI, 0, 0);
            await flush();
            const request = requireLastRequest(transport.messages, 'textDocument/hover');
            transport.emit({ jsonrpc: '2.0', id: request.id, result: { contents: 'recovered' } });
            expect(await hoverPromise).toEqual({ contents: 'recovered' });
        } finally {
            await safeShutdown(client, transport);
        }
    });

    it('rejects pending requests and reports a retryable error when the process closes (crash)', async () => {
        const { client, transport } = makeClient();
        try {
            await initializeClient(client, transport);
            const hoverPromise = client.hover(SAMPLE_URI, 0, 0);
            await flush();
            transport.simulateClose(1);
            await expect(hoverPromise).rejects.toThrow(/closed/);
            const error = asToolError(await hoverPromise.catch((caught: unknown) => caught));
            expect(error.error.retryable).toBe(true);
            // A subsequent call also fails because the client is closed.
            await expect(client.hover(SAMPLE_URI, 0, 0)).rejects.toBeInstanceOf(ToolExecutionError);
        } finally {
            await safeShutdown(client, transport);
        }
    });

    it('shutdown() sends a shutdown request then an exit notification and kills the child', async () => {
        const { client, transport } = makeClient();
        await initializeClient(client, transport);
        const shutdownPromise = client.shutdown();
        await flush();
        const request = requireLastRequest(transport.messages, 'shutdown');
        transport.emit({ jsonrpc: '2.0', id: request.id, result: null });
        await shutdownPromise;
        expect(findNotification(transport.messages, 'exit')).toBeDefined();
        expect(transport.killSignals.length).toBeGreaterThan(0);
    });

    it('honors a pre-aborted signal by rejecting initialize with a retryable error', async () => {
        const transport = new MockLspTransport();
        const controller = new AbortController();
        controller.abort();
        const client = new StdioLspClient(
            { command: 'gopls', args: ['serve'], workspaceRoot: WORKSPACE_ROOT, signal: controller.signal },
            { createTransport: () => transport, resolveDocument: async () => ({ content: '', languageId: 'go' }) },
        );
        await expect(client.initialize()).rejects.toThrow(/aborted before initialize/);
        await expect(client.initialize()).rejects.toBeInstanceOf(ToolExecutionError);
    });

    it('rejects hover before initialize with a retryable ToolExecutionError', async () => {
        const { client, transport } = makeClient();
        try {
            await expect(client.hover(SAMPLE_URI, 0, 0)).rejects.toBeInstanceOf(ToolExecutionError);
        } finally {
            await safeShutdown(client, transport);
        }
    });
});
