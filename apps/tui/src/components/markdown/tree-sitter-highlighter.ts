/**
 * Tree-sitter-backed syntax highlighter orchestrator.
 *
 * Bridges opentui's ASYNC tree-sitter engine to the existing SYNC
 * `highlightCode(code, lang) => HighlightedLine[]` contract via a
 * cache-miss-then-async-fill pattern:
 *
 * 1. {@link highlightTreeSitter} is called synchronously by the renderer. On a
 *    cache MISS it returns monochrome immediately and fires-and-forgets an
 *    async parse ({@link scheduleAsyncHighlight}).
 * 2. When the async parse resolves the colored result is cached, the markdown
 *    render LRU is invalidated ({@link clearRenderCache}), and the version
 *    emitter notifies render subscribers (via {@link subscribeHighlight} /
 *    {@link getHighlightVersion}) so the block re-renders and hits the cache.
 *
 * The opentui worker is lazily initialized on the FIRST highlight call (never
 * at module import), so non-TUI paths (`--no-tui` / `--json`) never start it.
 * Every opentui boundary (client acquisition, style construction, parser
 * registration, data-path resolution, chunk conversion) routes through the
 * {@link HighlighterRuntime} seam so unit tests inject fakes with no native
 * core and no network. Highlighting NEVER throws into the renderer: every
 * failure path degrades to monochrome and logs a diagnostic to stderr.
 */

import { errorToString, resolveMissionControlDataDir } from '@mission-control/core';
import type { FiletypeParserOptions, SimpleHighlight, TextChunk, TreeSitterClient } from '@opentui/core';
import {
    addDefaultParsers,
    destroyTreeSitterClient,
    getTreeSitterClient,
    infoStringToFiletype,
    SyntaxStyle,
    treeSitterToTextChunks,
} from '@opentui/core';
import type { HighlightedLine, HighlightedSpan } from './highlight';
import { TREE_SITTER_PARSERS } from './parsers-config';
import { clearRenderCache } from './render-cache';
import { buildSyntaxRules } from './syntax-rules';
import { textChunkToSpan } from './text-attributes';
import type { TerminalTextStyle } from './theme';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Mockable seam over every opentui / data-dir boundary. The default
 * implementation ({@link defaultRuntime}) calls the real opentui functions;
 * tests inject a fake via {@link setHighlighterRuntime} so no worker or native
 * core is touched.
 */
export interface HighlighterRuntime {
    /** Acquire the tree-sitter client singleton. Default: `getTreeSitterClient()`. */
    getClient(): TreeSitterClient;
    /** Tear down the client singleton. Default: `destroyTreeSitterClient()`. */
    destroyClient(): Promise<void>;
    /** Build the native {@link SyntaxStyle}. Default: `SyntaxStyle.fromTheme(buildSyntaxRules())`. */
    buildSyntaxStyle(): SyntaxStyle;
    /** Resolve the mission-control data dir for grammar WASM caching. */
    resolveDataPath(): string;
    /** Register filetype parsers. Default: `addDefaultParsers([...parsers])`. */
    registerParsers(parsers: readonly FiletypeParserOptions[]): void;
    /**
     * Convert offset highlights into styled {@link TextChunk}s. Conceal is
     * disabled (all source text visible). Default: `treeSitterToTextChunks`.
     */
    toTextChunks(content: string, highlights: SimpleHighlight[], syntaxStyle: SyntaxStyle): readonly TextChunk[];
    /** Map a fence info-string (e.g. 'ts', 'py') to a tree-sitter filetype. Default: `infoStringToFiletype`. */
    filetypeFromInfoString(infoString: string): string | undefined;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const NO_STYLE: TerminalTextStyle = {};

/** Monochrome fallback: one unstyled span per source line. */
export function monochrome(code: string): readonly HighlightedLine[] {
    return code.split('\n').map((line) => ({ spans: [{ text: line, style: NO_STYLE }] }));
}

let initPromise: Promise<void> | null = null;
let initGeneration = 0;
let syntaxStyle: SyntaxStyle | null = null;
let parsersRegistered = false;
let highlighterGeneration = 0;

/** LRU cap for asyncResultCache. Without it, long streaming sessions accumulate one entry per unique code block ever highlighted (native TextBuffer/SyntaxStyle pressure). */
const ASYNC_RESULT_CACHE_LIMIT = 256;
/** Bound worker pressure; a streamed fence otherwise schedules one parse per prefix. */
const MAX_ASYNC_HIGHLIGHT_IN_FLIGHT = 2;

const asyncResultCache = new Map<string, readonly HighlightedLine[]>();
const inFlight = new Map<string, Promise<void>>();

interface HighlightRequest {
    readonly code: string;
    readonly filetype: string;
    readonly key: string;
    readonly generation: number;
    readonly runtime: HighlighterRuntime;
}

/** At saturation only the most recent miss is retained; a future render can reschedule any older block. */
let deferredHighlight: HighlightRequest | undefined;
let invalidationScheduledForGeneration: number | undefined;
let highlightVersion = 0;
const highlightListeners = new Set<() => void>();

/** Snapshot version for highlight subscriptions; bumps after every async fill. */
export function getHighlightVersion(): number {
    return highlightVersion;
}

/** Subscribe to async-fill notifications; returns an unsubscribe function. */
export function subscribeHighlight(listener: () => void): () => void {
    highlightListeners.add(listener);
    return () => {
        highlightListeners.delete(listener);
    };
}

function notifyHighlightListeners(): void {
    highlightVersion += 1;
    for (const listener of highlightListeners) {
        listener();
    }
}

/** Batch cache invalidation and listener publication from concurrent worker completions. */
function scheduleHighlightInvalidation(generation: number): void {
    if (invalidationScheduledForGeneration === generation) return;
    invalidationScheduledForGeneration = generation;
    queueMicrotask(() => {
        if (invalidationScheduledForGeneration !== generation) return;
        invalidationScheduledForGeneration = undefined;
        if (generation !== highlighterGeneration) return;
        clearRenderCache();
        notifyHighlightListeners();
    });
}

function cacheKey(filetype: string, code: string): string {
    return `${filetype}\u0000${code}`;
}

/** LRU read: re-insert on hit so Map iteration order reflects recency. */
function readCachedLines(key: string): readonly HighlightedLine[] | undefined {
    const cached = asyncResultCache.get(key);
    if (cached === undefined) return undefined;
    asyncResultCache.delete(key);
    asyncResultCache.set(key, cached);
    return cached;
}

/** LRU write: drop oldest when over cap. */
function writeCachedLines(key: string, lines: readonly HighlightedLine[]): void {
    asyncResultCache.set(key, lines);
    if (asyncResultCache.size > ASYNC_RESULT_CACHE_LIMIT) {
        const oldest = asyncResultCache.keys().next().value;
        if (oldest !== undefined) asyncResultCache.delete(oldest);
    }
}

// ---------------------------------------------------------------------------
// Runtime seam
// ---------------------------------------------------------------------------

const defaultRuntime: HighlighterRuntime = {
    getClient: () => getTreeSitterClient(),
    destroyClient: () => destroyTreeSitterClient(),
    buildSyntaxStyle: () => SyntaxStyle.fromTheme([...buildSyntaxRules()]),
    resolveDataPath: () => resolveMissionControlDataDir(),
    registerParsers: (parsers) => addDefaultParsers([...parsers]),
    toTextChunks: (content, highlights, style) =>
        treeSitterToTextChunks(content, highlights, style, { enabled: false }),
    filetypeFromInfoString: (infoString) => infoStringToFiletype(infoString),
};

let runtime: HighlighterRuntime = defaultRuntime;

/** Swap the runtime seam (intended for tests). */
export function setHighlighterRuntime(next: HighlighterRuntime): void {
    runtime = next;
}

// ---------------------------------------------------------------------------
// Lazy singleton init
// ---------------------------------------------------------------------------

/**
 * Initialize the worker ONCE on first use. setDataPath runs BEFORE parser
 * registration so grammar WASM caches into the mission-control data dir. The
 * shared in-flight promise deduplicates concurrent first callers; on failure
 * the state is cleared so a later call can retry.
 */
function initHighlighter(generation: number, activeRuntime: HighlighterRuntime): Promise<void> {
    if (initPromise !== null && initGeneration === generation) return initPromise;
    initGeneration = generation;
    const initialized = doInit(generation, activeRuntime).catch((error: unknown) => {
        if (generation === highlighterGeneration) {
            initPromise = null;
            syntaxStyle = null;
        }
        throw error;
    });
    initPromise = initialized;
    return initialized;
}

async function doInit(generation: number, activeRuntime: HighlighterRuntime): Promise<void> {
    const client = activeRuntime.getClient();
    await client.setDataPath(activeRuntime.resolveDataPath());
    if (generation !== highlighterGeneration) return;
    if (!parsersRegistered) {
        activeRuntime.registerParsers(TREE_SITTER_PARSERS);
        if (generation !== highlighterGeneration) return;
        parsersRegistered = true;
    }
    try {
        const style = activeRuntime.buildSyntaxStyle();
        if (generation !== highlighterGeneration) {
            style.destroy();
            return;
        }
        syntaxStyle = style;
    } catch (error: unknown) {
        if (generation !== highlighterGeneration) return;
        syntaxStyle = null;
        const message = errorToString(error);
        process.stderr.write(`tree-sitter SyntaxStyle unavailable: ${message}\n`);
    }
}

// ---------------------------------------------------------------------------
// Async fill
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget an async parse for (code, filetype). Deduplicated against the
 * cache and any in-flight parse for the same key. At worker capacity, preserves
 * only the newest miss so streaming prefixes cannot create unbounded native
 * work. Successful fills batch their render invalidation. Never throws and
 * never rethrows; failures degrade to monochrome with a stderr log.
 */
function scheduleAsyncHighlight(code: string, filetype: string): void {
    const key = cacheKey(filetype, code);
    if (asyncResultCache.has(key) || inFlight.has(key) || deferredHighlight?.key === key) return;
    const request: HighlightRequest = {
        code,
        filetype,
        key,
        generation: highlighterGeneration,
        runtime,
    };
    if (inFlight.size >= MAX_ASYNC_HIGHLIGHT_IN_FLIGHT) {
        deferredHighlight = request;
        return;
    }
    startAsyncHighlight(request);
}

function startAsyncHighlight(request: HighlightRequest): void {
    const task = (async (): Promise<void> => {
        try {
            await initHighlighter(request.generation, request.runtime);
            if (request.generation !== highlighterGeneration) return;
            const style = syntaxStyle;
            if (style === null) return;
            const client = request.runtime.getClient();
            const result = await client.highlightOnce(request.code, request.filetype);
            if (request.generation !== highlighterGeneration || result.error !== undefined) return;
            const highlights = result.highlights;
            if (highlights === undefined) return;
            const chunks = request.runtime.toTextChunks(request.code, highlights, style);
            const lines = chunksToLines(chunks);
            if (request.generation !== highlighterGeneration) return;
            writeCachedLines(request.key, lines);
            scheduleHighlightInvalidation(request.generation);
        } catch (error: unknown) {
            if (request.generation !== highlighterGeneration) return;
            process.stderr.write(`tree-sitter highlight failed: ${errorToString(error)}\n`);
        }
    })();

    inFlight.set(request.key, task);
    void task.finally(() => {
        if (inFlight.get(request.key) === task) {
            inFlight.delete(request.key);
        }
        startDeferredHighlight();
    });
}

function startDeferredHighlight(): void {
    if (inFlight.size >= MAX_ASYNC_HIGHLIGHT_IN_FLIGHT) return;
    const request = deferredHighlight;
    if (request === undefined) return;
    deferredHighlight = undefined;
    if (
        request.generation !== highlighterGeneration ||
        asyncResultCache.has(request.key) ||
        inFlight.has(request.key)
    ) {
        startDeferredHighlight();
        return;
    }
    startAsyncHighlight(request);
}

/**
 * Split styled chunks into one {@link HighlightedLine} per source line. A chunk
 * whose text spans `\n` is divided across consecutive lines, each fragment
 * keeping the chunk's color/attribute style. For well-formed input the result
 * line count equals `code.split('\n').length`.
 */
function chunksToLines(chunks: readonly TextChunk[]): readonly HighlightedLine[] {
    type MutableLine = { spans: HighlightedSpan[] };
    const lines: MutableLine[] = [{ spans: [] }];
    for (const chunk of chunks) {
        const parts = chunk.text.split('\n');
        for (let index = 0; index < parts.length; index++) {
            if (index > 0) lines.push({ spans: [] });
            const part = parts[index];
            if (part !== undefined && part.length > 0) {
                const current = lines[lines.length - 1];
                if (current !== undefined) {
                    current.spans.push(
                        textChunkToSpan({
                            text: part,
                            ...(chunk.fg !== undefined ? { fg: chunk.fg } : {}),
                            ...(chunk.bg !== undefined ? { bg: chunk.bg } : {}),
                            ...(chunk.attributes !== undefined ? { attributes: chunk.attributes } : {}),
                        }),
                    );
                }
            }
        }
    }
    return lines;
}

// ---------------------------------------------------------------------------
// Sync entry point
// ---------------------------------------------------------------------------

/**
 * Synchronously highlight `code` as `lang`. On a cache MISS returns monochrome
 * immediately and schedules an async fill; the next call after the fill lands
 * returns the colored lines. Never throws and never awaits. Unsupported or
 * unknown languages return monochrome with no schedule.
 */
export function highlightTreeSitter(code: string, lang?: string): readonly HighlightedLine[] {
    const filetype = lang !== undefined ? runtime.filetypeFromInfoString(lang) : undefined;
    if (filetype === undefined) return monochrome(code);

    const key = cacheKey(filetype, code);
    const cached = readCachedLines(key);
    if (cached !== undefined) return cached;

    try {
        scheduleAsyncHighlight(code, filetype);
    } catch {}
    return monochrome(code);
}

// ---------------------------------------------------------------------------
// Teardown + test reset
// ---------------------------------------------------------------------------

/**
 * Tear down the tree-sitter client and built style. Intended for process exit
 * / SIGINT. Idempotent; never throws (logs to stderr on failure).
 */
export async function closeTreeSitterClient(): Promise<void> {
    highlighterGeneration += 1;
    initPromise = null;
    parsersRegistered = false;
    deferredHighlight = undefined;
    invalidationScheduledForGeneration = undefined;
    try {
        if (syntaxStyle !== null) {
            syntaxStyle.destroy();
            syntaxStyle = null;
        }
        await runtime.destroyClient();
    } catch {}
}

/**
 * Reset all singleton state for deterministic test isolation: destroys any
 * built style, clears caches/in-flight/listeners, zeroes the version counter,
 * and restores the default runtime.
 */
export function resetHighlighterForTest(): void {
    highlighterGeneration += 1;
    if (syntaxStyle !== null) {
        try {
            syntaxStyle.destroy();
        } catch {
            // Test cleanup must not throw.
        }
    }
    syntaxStyle = null;
    initPromise = null;
    parsersRegistered = false;
    asyncResultCache.clear();
    inFlight.clear();
    deferredHighlight = undefined;
    invalidationScheduledForGeneration = undefined;
    highlightListeners.clear();
    highlightVersion = 0;
    runtime = defaultRuntime;
}
