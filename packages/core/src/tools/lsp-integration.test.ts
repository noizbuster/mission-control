/**
 * LSP end-to-end integration tests (task 19).
 *
 * Drives the REAL `StdioLspClient` against a real `typescript-language-server`
 * process on PATH. Temp TypeScript files are written under `os.tmpdir()`, the
 * client opens them through the production `didOpen` path, and each test asserts
 * on the server's real answers for hover, diagnostics, and definition.
 *
 * The suite skips itself when `typescript-language-server` is unavailable so CI
 * without the binary stays green. Diagnostics arrive asynchronously via the
 * `textDocument/publishDiagnostics` notification; `waitForDiagnostics` polls the
 * client cache with a bounded deadline so the test is deterministic without sleeps.
 *
 * Note on the diagnostics scenario: `StdioLspClient` currently sends
 * `capabilities: {}` during `initialize`, so `typescript-language-server` v5+
 * (which gates diagnostic push on `clientCapabilities.textDocument.publishDiagnostics`)
 * never pushes diagnostics through the default transport. The diagnostics test
 * injects a thin transport decorator via the client's public `createTransport`
 * seam that advertises that one capability while still spawning the real server
 * and exercising the real framing / decode / dispatch / map / cache pipeline.
 * Hover and definition run against the unmodified default client.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { LspTransport, LspTransportFactory, StdioLspClientDeps } from './lsp-stdio-client.js';
import { decodeLspFrame, encodeLspMessage, StdioLspClient } from './lsp-stdio-client.js';
import type { LspDiagnostic } from './lsp-tool.js';
import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVER_AVAILABLE = detectServer();
const workspaces: string[] = [];

const TEST_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const DIAGNOSTIC_WAIT_MS = 5_000;

describe.skipIf(!SERVER_AVAILABLE)('StdioLspClient against the real typescript-language-server', () => {
    afterEach(async () => {
        const pending = workspaces.splice(0, workspaces.length);
        await Promise.all(pending.map((workspace) => rm(workspace, { recursive: true, force: true })));
    });

    it(
        'returns hover info for a known symbol',
        async () => {
            // Given: a temp TS file with a typed string binding
            const { root, uri } = await writeFixture('hover.ts', HOVER_TS);

            // When: asking for hover over the `greeting` identifier (line 0, char 6)
            const client = await createClient(root);
            try {
                const hover = await client.hover(uri, 0, 6);

                // Then: the server returns type info mentioning the symbol name
                expect(hover).toBeDefined();
                expect(hover?.contents.length).toBeGreaterThan(0);
                expect(hover?.contents).toContain('greeting');
            } finally {
                await client.shutdown();
            }
        },
        TEST_TIMEOUT_MS,
    );

    it(
        'reports diagnostics for a file with a type error',
        async () => {
            // Given: a temp TS file with a number/string type mismatch
            const { root, uri } = await writeFixture('diag.ts', DIAG_TS);

            // When: opening the document (via hover) then waiting for the pushed
            // diagnostics. The capability-advertising transport is required because
            // the default client omits `textDocument.publishDiagnostics` (see header).
            const client = await createClient(root, { createTransport: publishDiagnosticsTransport });
            try {
                await client.hover(uri, 0, 6);
                const diagnostics = await waitForDiagnostics(client, uri);

                // Then: at least one error-severity diagnostic is reported
                expect(diagnostics.length).toBeGreaterThan(0);
                const errors = diagnostics.filter((diag) => diag.severity === 'error');
                expect(errors.length).toBeGreaterThan(0);
            } finally {
                await client.shutdown();
            }
        },
        TEST_TIMEOUT_MS,
    );

    it(
        'resolves definition of a referenced symbol to its declaration',
        async () => {
            // Given: a temp TS file where `greet` is declared on line 0 then called on line 3
            const { root, uri } = await writeFixture('def.ts', DEFINITION_TS);

            // When: asking for definition at the `greet` call site (line 3, char 16)
            const client = await createClient(root);
            try {
                const locations = await client.definition(uri, 3, 16);

                // Then: exactly one location, in the same file, on the declaration line (0)
                expect(locations).toHaveLength(1);
                const location = locations[0];
                expect(location?.uri).toBe(uri);
                expect(location?.line).toBe(0);
            } finally {
                await client.shutdown();
            }
        },
        TEST_TIMEOUT_MS,
    );
});

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const HOVER_TS = ['const greeting: string = "hello world";', 'console.log(greeting);', ''].join('\n');

const DIAG_TS = ['const value: number = "definitely a string";', ''].join('\n');

const DEFINITION_TS = [
    'function greet(name: string): string {',
    '  return "hi " + name;',
    '}',
    'const message = greet("world");',
    '',
].join('\n');

async function writeFixture(
    filename: string,
    content: string,
): Promise<{ readonly root: string; readonly uri: string }> {
    const root = await mkdtemp(join(tmpdir(), 'mctrl-lsp-'));
    workspaces.push(root);
    await writeFile(join(root, filename), content, 'utf8');
    return { root, uri: pathToUri(join(root, filename)) };
}

async function createClient(workspaceRoot: string, deps?: StdioLspClientDeps): Promise<StdioLspClient> {
    const client = new StdioLspClient(
        {
            command: 'typescript-language-server',
            args: ['--stdio'],
            workspaceRoot,
            requestTimeoutMs: REQUEST_TIMEOUT_MS,
        },
        deps,
    );
    await client.initialize();
    return client;
}

function pathToUri(absolutePath: string): string {
    // absolutePath begins with '/', so 'file://' + it yields the canonical three-slash form.
    return `file://${absolutePath}`;
}

/**
 * Poll the client's diagnostics cache until at least one diagnostic arrives or
 * the deadline lapses. `publishDiagnostics` is an async server notification,
 * so the cache may be empty immediately after `didOpen`.
 */
async function waitForDiagnostics(client: StdioLspClient, uri: string): Promise<readonly LspDiagnostic[]> {
    const deadline = Date.now() + DIAGNOSTIC_WAIT_MS;
    for (;;) {
        const diagnostics = await client.diagnostics(uri);
        if (diagnostics.length > 0) return diagnostics;
        if (Date.now() >= deadline) return diagnostics;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

function detectServer(): boolean {
    try {
        const result = spawnSync('typescript-language-server', ['--version'], {
            encoding: 'utf8',
            windowsHide: true,
        });
        return result.status === 0 && (result.stdout ?? '').trim().length > 0;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Capability-advertising transport (diagnostics scenario only)
// ---------------------------------------------------------------------------

/**
 * Factory for a transport that spawns the real language-server process and
 * advertises `textDocument.publishDiagnostics` in the `initialize` handshake.
 * See the file header for why this is necessary for v5+ servers.
 */
const publishDiagnosticsTransport: LspTransportFactory = (input) =>
    new CapabilityAdvertisingTransport(input, { textDocument: { publishDiagnostics: {} } });

class CapabilityAdvertisingTransport implements LspTransport {
    private readonly child: ChildProcess;
    private readonly extraCapabilities: Readonly<Record<string, unknown>>;
    private readonly dataHandlers: Array<(chunk: Buffer) => void> = [];
    private readonly closeHandlers: Array<(exitCode: number | null) => void> = [];
    private terminated = false;

    constructor(
        input: {
            readonly command: string;
            readonly args: readonly string[];
            readonly cwd: string;
            readonly env?: Readonly<Record<string, string>>;
        },
        extraCapabilities: Readonly<Record<string, unknown>>,
    ) {
        this.extraCapabilities = extraCapabilities;
        this.child = spawn(input.command, [...input.args], {
            cwd: input.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            ...(input.env !== undefined ? { env: { ...process.env, ...input.env } } : {}),
        });
        this.child.stdout?.on('data', (chunk: Buffer) => {
            for (const handler of this.dataHandlers) handler(chunk);
        });
        const finalize = (exitCode: number | null): void => {
            if (this.terminated) return;
            this.terminated = true;
            for (const handler of this.closeHandlers) handler(exitCode);
        };
        this.child.on('close', finalize);
        this.child.on('error', () => finalize(null));
    }

    write(buffer: Buffer): void {
        const rewritten = injectCapabilities(buffer, this.extraCapabilities);
        try {
            this.child.stdin?.write(rewritten);
        } catch {
            // Child already gone; the pending request will be rejected by the close handler.
        }
    }

    onData(handler: (chunk: Buffer) => void): void {
        this.dataHandlers.push(handler);
    }

    onClose(handler: (exitCode: number | null) => void): void {
        this.closeHandlers.push(handler);
    }

    kill(signal?: NodeJS.Signals): void {
        try {
            this.child.kill(signal);
        } catch {
            // Process already gone.
        }
    }
}

/** Merge `extra` capabilities into the `initialize` request frame; pass other frames through. */
function injectCapabilities(frame: Buffer, extra: Readonly<Record<string, unknown>>): Buffer {
    const message = decodeLspFrame(frame);
    if (!isRecord(message) || message['method'] !== 'initialize') return frame;
    const params = message['params'];
    const existing = isRecord(params) && isRecord(params['capabilities']) ? params['capabilities'] : {};
    const mergedParams = isRecord(params)
        ? { ...params, capabilities: { ...existing, ...extra } }
        : { capabilities: extra };
    return encodeLspMessage({ ...message, params: mergedParams });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
