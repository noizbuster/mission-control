/**
 * `browser` tool (Task 31, port-ref-tools checkbox #31): drive a real browser
 * over CDP via `puppeteer-core` (peer dep, NO bundled Chromium).
 *
 * DECISION (committed): option (b) — no Chromium download. The tool attaches to
 * a user-supplied Chrome exposing a DevTools Protocol endpoint
 * (`browser.chrome_endpoint`). It never launches or downloads Chromium itself.
 *
 * Config-gated: `createBrowserToolRegistration` returns `null` when no
 * `chromeEndpoint` is configured, so the model can never discover a half-wired
 * browser surface — mirroring the ssh tool's config gate.
 *
 * Containment parity: class `['network','exec']`, exec tier (trusted workspace
 * required), approval-required network permission, outputLimit on model output,
 * secret redaction, and a hard screenshot byte cap. Ported from oh-my-pi's
 * `browser` tool (MIT, Can Boluk / Mario Zechner), rewritten to mission-control's
 * ToolRegistration contract and stripped of the multi-tab supervisor / cmux /
 * stealth machinery that belong to oh-my-pi's richer runtime.
 *
 * The CDP attachment is exposed as an injectable `BrowserConnectFn` seam so unit
 * tests exercise navigate/extract/screenshot against a fully mocked CDP without
 * puppeteer-core installed or a real Chrome running. The default connector
 * (`createPuppeteerCoreConnector`) lazy-imports `puppeteer-core` at runtime.
 */
import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { z } from 'zod';
import { redactCredentialText } from '../providers/credential-resolver.js';
import { assertTrustedWorkspace } from './bash-run-policy.js';
import { permissionRequest, requestToolPermission } from './tool-permissions.js';
import { type ToolAdvertisement, type ToolRegistration, ToolRegistry } from './tool-registry.js';
import type { ToolExecutionContext } from './tool-registry-types.js';
import { ToolExecutionError } from './tool-registry-types.js';
import { truncateOutput } from './truncate.js';

const BROWSER_TOOL_NAME = 'browser';
const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_PROTOCOL_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_MODEL_OUTPUT_CHARS = 16_000;
const DEFAULT_MAX_SCREENSHOT_BYTES = 256 * 1024;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const BASE64_SAFETY_MARGIN = 1.5;

const BROWSER_TOOL_DESCRIPTION =
    'Drive a real browser over the Chrome DevTools Protocol (CDP). Attaches to a user-supplied Chrome ' +
    'exposed via a CDP endpoint; does NOT download or launch Chromium. Three actions:\n' +
    '- navigate (default): open a URL, wait for load, and return the page title + readable text.\n' +
    '- extract: re-extract readable text or HTML from the currently loaded page (no navigation).\n' +
    '- screenshot: capture a screenshot as base64 (byte-capped).';

const BROWSER_TOOL_GUIDELINE =
    'Use the browser tool to read live web pages that local files, webfetch, or search cannot answer. ' +
    'Prefer navigate (which returns readable text in one call) over manual extract. Screenshots are byte-capped ' +
    'and count against the output budget — use text extraction first. Requires a trusted workspace and approval.';

// ---------------------------------------------------------------------------
// CDP connector seam (injectable; mocked in tests, puppeteer-core in prod)
// ---------------------------------------------------------------------------

export type BrowserWaitUntil = 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';

export interface BrowserPageSeam {
    goto(url: string, waitUntil: BrowserWaitUntil, timeoutMs: number, signal: AbortSignal): Promise<void>;
    url(): string;
    title(): Promise<string>;
    extractText(): Promise<string>;
    extractHtml(): Promise<string>;
    screenshot(): Promise<Uint8Array>;
    close(): Promise<void>;
}

export interface BrowserConnectionSeam {
    readonly connected: boolean;
    newPage(): Promise<BrowserPageSeam>;
    disconnect(): Promise<void>;
}

export interface BrowserConnectRuntimeOptions {
    readonly protocolTimeoutMs: number;
    readonly defaultViewport: { readonly width: number; readonly height: number };
}

export type BrowserConnectFn = (
    endpoint: string,
    options: BrowserConnectRuntimeOptions,
    signal: AbortSignal,
) => Promise<BrowserConnectionSeam>;

/**
 * Minimal structural interface compatible with `puppeteer-core`'s `connect` +
 * `Browser`/`Page`. Declared locally so this file type-checks even when
 * `puppeteer-core` (an optional peer dependency) is absent from the install graph.
 * It intentionally captures only the surface this tool touches.
 */
interface PuppeteerCoreConnectable {
    connect(options: {
        readonly browserURL: string;
        readonly defaultViewport: { readonly width: number; readonly height: number } | null;
        readonly protocolTimeout?: number;
    }): Promise<PuppeteerBrowserLike>;
}

interface PuppeteerBrowserLike {
    readonly connected: boolean;
    newPage(): Promise<PuppeteerPageLike>;
    disconnect(): void;
}

interface PuppeteerPageLike {
    goto(url: string, options: { readonly waitUntil?: string; readonly timeout?: number }): Promise<unknown>;
    url(): string;
    title(): Promise<string>;
    evaluate<T>(fn: () => T): Promise<T>;
    content(): Promise<string>;
    screenshot(): Promise<Uint8Array>;
    close(): Promise<void>;
}

let cachedPuppeteerCore: PuppeteerCoreConnectable | undefined;

async function loadPuppeteerCore(): Promise<PuppeteerCoreConnectable> {
    if (cachedPuppeteerCore !== undefined) {
        return cachedPuppeteerCore;
    }
    // puppeteer-core is an optional peer dependency (NOT puppeteer, which downloads
    // Chromium). A variable specifier keeps TypeScript from resolving the module at
    // compile time, so this file type-checks even when puppeteer-core is absent.
    const moduleId = 'puppeteer-core';
    const mod = (await import(moduleId)) as PuppeteerCoreConnectable;
    cachedPuppeteerCore = mod;
    return mod;
}

/**
 * Build the default {@link BrowserConnectFn} backed by `puppeteer-core`.
 * Throws a clear error if puppeteer-core is not installed, since this package
 * intentionally does not bundle or auto-install it (no Chromium download).
 */
export function createPuppeteerCoreConnector(): BrowserConnectFn {
    return async (endpoint, options, signal) => {
        let puppeteer: PuppeteerCoreConnectable;
        try {
            puppeteer = await loadPuppeteerCore();
        } catch (error: unknown) {
            const detail = error instanceof Error ? error.message : String(error);
            throw browserFailure(
                `browser requires the optional peer dependency puppeteer-core to be installed ` +
                    `(NOT puppeteer, which downloads Chromium). Install it with: pnpm add puppeteer-core. ${detail}`,
            );
        }
        const browser = await puppeteer.connect({
            browserURL: endpoint,
            defaultViewport: options.defaultViewport,
            protocolTimeout: options.protocolTimeoutMs,
        });
        if (signal.aborted) {
            safeDisconnect(browser);
            throw browserFailure('browser connection aborted');
        }
        return wrapPuppeteerBrowser(browser);
    };
}

function wrapPuppeteerBrowser(browser: PuppeteerBrowserLike): BrowserConnectionSeam {
    return {
        get connected(): boolean {
            return browser.connected;
        },
        async newPage() {
            const page = await browser.newPage();
            return wrapPuppeteerPage(page);
        },
        async disconnect() {
            safeDisconnect(browser);
        },
    };
}

function wrapPuppeteerPage(page: PuppeteerPageLike): BrowserPageSeam {
    return {
        async goto(url, waitUntil, timeoutMs, signal) {
            if (signal.aborted) throw browserFailure('navigation aborted');
            await page.goto(url, { waitUntil, timeout: timeoutMs });
        },
        url: () => page.url(),
        title: () => page.title(),
        extractText: () => page.evaluate(() => document.body?.innerText ?? ''),
        extractHtml: () => page.content(),
        screenshot: () => page.screenshot(),
        close: () => page.close(),
    };
}

function safeDisconnect(browser: PuppeteerBrowserLike): void {
    try {
        if (browser.connected) {
            browser.disconnect();
        }
    } catch {
        // Best-effort teardown; connection errors during cleanup are not actionable.
    }
}

// ---------------------------------------------------------------------------
// Input / output schemas
// ---------------------------------------------------------------------------

export const browserInputSchema = z
    .object({
        action: z.enum(['navigate', 'extract', 'screenshot']),
        url: z.string().min(1).max(8_192).optional(),
        waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2']).optional(),
        format: z.enum(['text', 'html']).optional(),
        timeout: z.number().int().positive().max(300).optional(),
    })
    .strict();
export type BrowserInput = z.infer<typeof browserInputSchema>;

export const browserOutputSchema = z
    .object({
        kind: z.literal('browser'),
        action: z.enum(['navigate', 'extract', 'screenshot']),
        url: z.string(),
        title: z.string(),
        status: z.enum(['completed', 'failed', 'timed_out']),
        text: z.string().optional(),
        truncated: z.boolean(),
        originalLength: z.number().int().nonnegative(),
        returnedLength: z.number().int().nonnegative(),
        screenshotBase64: z.string().optional(),
        screenshotBytes: z.number().int().nonnegative().optional(),
        durationMs: z.number().int().nonnegative(),
    })
    .strict();
export type BrowserOutput = z.infer<typeof browserOutputSchema>;

// ---------------------------------------------------------------------------
// Tool options + registration
// ---------------------------------------------------------------------------

export type BrowserToolOptions = {
    readonly workspaceRoot: string;
    readonly workspaceTrust: 'trusted' | 'denied' | 'unknown';
    readonly chromeEndpoint: string;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    readonly connect?: BrowserConnectFn;
    readonly protocolTimeoutMs?: number;
    readonly defaultViewport?: { readonly width: number; readonly height: number };
    readonly maxModelOutputChars?: number;
    readonly maxScreenshotBytes?: number;
    readonly redactionSecrets?: readonly string[];
};

type ResolvedBrowserToolOptions = {
    readonly workspaceRoot: string;
    readonly workspaceTrust: BrowserToolOptions['workspaceTrust'];
    readonly chromeEndpoint: string;
    readonly connect: BrowserConnectFn;
    readonly requestPermission: BrowserToolOptions['requestPermission'];
    readonly protocolTimeoutMs: number;
    readonly defaultViewport: { readonly width: number; readonly height: number };
    readonly maxModelOutputChars: number;
    readonly maxScreenshotBytes: number;
    readonly redactionSecrets: readonly string[];
};

export async function registerBrowserTool(
    registry: ToolRegistry,
    options: BrowserToolOptions,
): Promise<ToolAdvertisement | null> {
    const registration = createBrowserToolRegistration(options);
    if (registration === null) {
        return null;
    }
    return registry.register(registration);
}

export function createBrowserToolRegistration(
    options: BrowserToolOptions,
): ToolRegistration<BrowserInput, BrowserOutput> | null {
    if (options.chromeEndpoint.trim().length === 0) {
        return null;
    }
    const resolved = resolveOptions(options);
    // Lazily-cached CDP connection, reused across calls within the same registration
    // instance. Reconnects when the connection drops.
    const connectionHolder: { current: BrowserConnectionSeam | null } = { current: null };
    return {
        name: BROWSER_TOOL_NAME,
        description: BROWSER_TOOL_DESCRIPTION,
        capabilityClasses: ['network', 'exec'],
        parametersJsonSchema: browserParametersJsonSchema(),
        // exactOptionalPropertyTypes: Zod infers `| undefined` on optional fields; the hand-written
        // input type omits it. Cast at the registration boundary, same pattern as ast_grep.
        inputSchema: browserInputSchema as z.ZodType<BrowserInput>,
        outputSchema: browserOutputSchema as z.ZodType<BrowserOutput>,
        outputLimit: { maxModelOutputChars: resolved.maxModelOutputChars },
        execute: (input, context) => runBrowserTool(resolved, input, context, connectionHolder),
        toModelOutput: browserModelOutput,
        guideline: BROWSER_TOOL_GUIDELINE,
    };
}

function resolveOptions(options: BrowserToolOptions): ResolvedBrowserToolOptions {
    return {
        workspaceRoot: options.workspaceRoot,
        workspaceTrust: options.workspaceTrust,
        chromeEndpoint: options.chromeEndpoint.replace(/\/+$/u, ''),
        connect: options.connect ?? createPuppeteerCoreConnector(),
        requestPermission: options.requestPermission,
        protocolTimeoutMs: options.protocolTimeoutMs ?? DEFAULT_PROTOCOL_TIMEOUT_MS,
        defaultViewport: options.defaultViewport ?? DEFAULT_VIEWPORT,
        maxModelOutputChars: options.maxModelOutputChars ?? DEFAULT_MAX_MODEL_OUTPUT_CHARS,
        maxScreenshotBytes: options.maxScreenshotBytes ?? DEFAULT_MAX_SCREENSHOT_BYTES,
        redactionSecrets: options.redactionSecrets ?? [],
    };
}

function browserParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['navigate', 'extract', 'screenshot'],
                description:
                    'Operation: navigate (open URL + extract text), extract (text/html from current page), or screenshot.',
            },
            url: { type: 'string', description: 'URL to navigate to (required for action "navigate").' },
            waitUntil: {
                type: 'string',
                enum: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'],
                description: 'Navigation wait condition (default "load").',
            },
            format: {
                type: 'string',
                enum: ['text', 'html'],
                description: 'Extraction format for extract action (default "text").',
            },
            timeout: { type: 'integer', description: 'Per-call timeout in seconds (default 30, max 300).' },
        },
        required: ['action'],
        additionalProperties: false,
    };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function runBrowserTool(
    options: ResolvedBrowserToolOptions,
    input: BrowserInput,
    context: ToolExecutionContext,
    connectionHolder: { current: BrowserConnectionSeam | null },
): Promise<BrowserOutput> {
    assertTrustedWorkspace(options.workspaceTrust);
    await requireBrowserApproval(options, context.toolCallId, input.action, input.url);

    const started = Date.now();
    const timeoutMs = (input.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    const controller = wireAbort(context.signal);
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);

    try {
        if (input.action === 'navigate') {
            return await runNavigate(options, input, controller.signal, connectionHolder, started, () => timedOut);
        }
        if (input.action === 'screenshot') {
            return await runScreenshot(options, controller.signal, connectionHolder, started, () => timedOut);
        }
        return await runExtract(options, input, controller.signal, connectionHolder, started, () => timedOut);
    } finally {
        clearTimeout(timeoutHandle);
    }
}

async function runNavigate(
    options: ResolvedBrowserToolOptions,
    input: BrowserInput,
    signal: AbortSignal,
    connectionHolder: { current: BrowserConnectionSeam | null },
    started: number,
    isTimedOut: () => boolean,
): Promise<BrowserOutput> {
    if (input.url === undefined) {
        throw browserFailure('action "navigate" requires a "url"');
    }
    const url = input.url;
    const page = await acquirePage(options, signal, connectionHolder);
    const waitUntil = input.waitUntil ?? 'load';
    const navTimeoutMs = (input.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    try {
        await page.goto(url, waitUntil, navTimeoutMs, signal);
    } catch (error: unknown) {
        if (isTimedOut()) {
            return browserOutput('navigate', page, { status: 'timed_out', started });
        }
        throw browserFailure(`navigation to ${url} failed: ${errorMessage(error)}`);
    }
    const raw = await safeExtractText(page);
    const title = await safeTitle(page);
    const limited = truncateOutput(redactCredentialText(raw, options.redactionSecrets), options.maxModelOutputChars);
    return browserOutput('navigate', page, {
        status: 'completed',
        started,
        title,
        text: limited.content,
        truncated: limited.truncated,
        originalLength: limited.originalLength,
    });
}

async function runExtract(
    options: ResolvedBrowserToolOptions,
    input: BrowserInput,
    signal: AbortSignal,
    connectionHolder: { current: BrowserConnectionSeam | null },
    started: number,
    isTimedOut: () => boolean,
): Promise<BrowserOutput> {
    const format = input.format ?? 'text';
    const page = await acquirePage(options, signal, connectionHolder);
    let raw: string;
    try {
        raw = format === 'html' ? await page.extractHtml() : await page.extractText();
    } catch (error: unknown) {
        if (isTimedOut()) {
            return browserOutput('extract', page, { status: 'timed_out', started });
        }
        throw browserFailure(`extraction failed: ${errorMessage(error)}`);
    }
    const title = await safeTitle(page);
    const limited = truncateOutput(redactCredentialText(raw, options.redactionSecrets), options.maxModelOutputChars);
    return browserOutput('extract', page, {
        status: 'completed',
        started,
        title,
        text: limited.content,
        truncated: limited.truncated,
        originalLength: limited.originalLength,
    });
}

async function runScreenshot(
    options: ResolvedBrowserToolOptions,
    signal: AbortSignal,
    connectionHolder: { current: BrowserConnectionSeam | null },
    started: number,
    isTimedOut: () => boolean,
): Promise<BrowserOutput> {
    const page = await acquirePage(options, signal, connectionHolder);
    let bytes: Uint8Array;
    try {
        bytes = await page.screenshot();
    } catch (error: unknown) {
        if (isTimedOut()) {
            return browserOutput('screenshot', page, { status: 'timed_out', started });
        }
        throw browserFailure(`screenshot failed: ${errorMessage(error)}`);
    }
    const capped = capScreenshot(bytes, options.maxScreenshotBytes);
    const title = await safeTitle(page);
    return browserOutput('screenshot', page, {
        status: 'completed',
        started,
        title,
        screenshotBase64: capped.base64,
        screenshotBytes: capped.bytes,
    });
}

// ---------------------------------------------------------------------------
// Connection + page acquisition
// ---------------------------------------------------------------------------

async function acquirePage(
    options: ResolvedBrowserToolOptions,
    signal: AbortSignal,
    connectionHolder: { current: BrowserConnectionSeam | null },
): Promise<BrowserPageSeam> {
    const existing = connectionHolder.current;
    if (existing !== null && existing.connected) {
        return existing.newPage();
    }
    let connection: BrowserConnectionSeam;
    try {
        connection = await options.connect(
            options.chromeEndpoint,
            {
                protocolTimeoutMs: options.protocolTimeoutMs,
                defaultViewport: options.defaultViewport,
            },
            signal,
        );
    } catch (error: unknown) {
        if (error instanceof ToolExecutionError) throw error;
        throw browserFailure(
            `failed to connect to Chrome CDP endpoint ${options.chromeEndpoint}: ${errorMessage(error)}`,
        );
    }
    connectionHolder.current = connection;
    try {
        return await connection.newPage();
    } catch (error: unknown) {
        throw browserFailure(`failed to open a browser page: ${errorMessage(error)}`);
    }
}

async function safeExtractText(page: BrowserPageSeam): Promise<string> {
    try {
        return await page.extractText();
    } catch {
        return await page.extractHtml();
    }
}

async function safeTitle(page: BrowserPageSeam): Promise<string> {
    try {
        return await page.title();
    } catch {
        return '';
    }
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

interface BrowserResultInput {
    readonly status: BrowserOutput['status'];
    readonly started: number;
    readonly title?: string;
    readonly text?: string;
    readonly truncated?: boolean;
    readonly originalLength?: number;
    readonly screenshotBase64?: string;
    readonly screenshotBytes?: number;
}

function browserOutput(
    action: BrowserOutput['action'],
    page: BrowserPageSeam,
    input: BrowserResultInput,
): BrowserOutput {
    const text = input.text ?? '';
    const result: BrowserOutput = {
        kind: 'browser',
        action,
        url: safePageUrl(page),
        title: input.title ?? '',
        status: input.status,
        truncated: input.truncated ?? false,
        originalLength: input.originalLength ?? text.length,
        returnedLength: text.length,
        durationMs: Date.now() - input.started,
    };
    if (text.length > 0) {
        return { ...result, text };
    }
    if (input.screenshotBase64 !== undefined && input.screenshotBytes !== undefined) {
        return { ...result, screenshotBase64: input.screenshotBase64, screenshotBytes: input.screenshotBytes };
    }
    return result;
}

function safePageUrl(page: BrowserPageSeam): string {
    try {
        return page.url();
    } catch {
        return '';
    }
}

function browserModelOutput(output: BrowserOutput): string {
    if (output.action === 'screenshot') {
        const lines = [`## browser screenshot (${output.screenshotBytes ?? 0} bytes)`];
        lines.push(`URL: ${output.url}`);
        if (output.truncated) lines.push('[screenshot capped]');
        return lines.join('\n');
    }
    const header = `## browser ${output.action}: ${output.url}`;
    const lines = [header];
    if (output.text !== undefined && output.text.length > 0) {
        lines.push(output.text);
    } else if (output.status !== 'completed') {
        lines.push(`[${output.status}]`);
    }
    if (output.truncated) {
        lines.push('[output truncated]');
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Permissions, abort, screenshot cap, errors
// ---------------------------------------------------------------------------

async function requireBrowserApproval(
    options: ResolvedBrowserToolOptions,
    toolCallId: string,
    action: BrowserInput['action'],
    url: string | undefined,
): Promise<void> {
    const reason = url !== undefined ? `browser ${action}: ${url}` : `browser ${action}`;
    const request = permissionRequest({
        toolCallId,
        action: 'browser',
        reason,
        permission: 'network',
        patterns: url !== undefined ? [url] : [options.chromeEndpoint],
        workspaceRoot: options.workspaceRoot,
    });
    const decision = await requestToolPermission(options.requestPermission, request);
    if (decision.status === 'allow') {
        return;
    }
    throw browserFailure(
        decision.status === 'deny'
            ? `approval_denied: ${decision.reason ?? 'browser denied'}`
            : `approval_required: ${decision.reason ?? 'browser requires approval'}`,
    );
}

function wireAbort(signal: AbortSignal): AbortController {
    const controller = new AbortController();
    if (signal.aborted) {
        controller.abort();
    } else {
        signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    return controller;
}

function capScreenshot(bytes: Uint8Array, maxBytes: number): { readonly base64: string; readonly bytes: number } {
    if (bytes.byteLength <= maxBytes) {
        return { base64: toBase64(bytes), bytes: bytes.byteLength };
    }
    const limit = Math.max(0, Math.floor(maxBytes / BASE64_SAFETY_MARGIN));
    const slice = bytes.subarray(0, limit);
    return { base64: toBase64(slice), bytes: limit };
}

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const end = Math.min(offset + chunkSize, bytes.length);
        binary += String.fromCharCode(...bytes.subarray(offset, end));
    }
    return Buffer.from(binary, 'binary').toString('base64');
}

function browserFailure(message: string): ToolExecutionError {
    return new ToolExecutionError({
        code: 'tool_failed',
        message,
        retryable: false,
    });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
