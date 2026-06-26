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
 *    emitter notifies React (via {@link subscribeHighlight} /
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

import { resolveMissionControlDataDir } from '@mission-control/core';
import type { FiletypeParserOptions, SimpleHighlight, TextChunk, TreeSitterClient } from '@opentui/core';
import {
    addDefaultParsers,
    destroyTreeSitterClient,
    getTreeSitterClient,
    infoStringToFiletype,
    SyntaxStyle,
    treeSitterToTextChunks,
} from '@opentui/core';
import type { HighlightedLine, HighlightedSpan } from './highlight.js';
import { TREE_SITTER_PARSERS } from './parsers-config.js';
import { clearRenderCache } from './render-cache.js';
import { buildSyntaxRules } from './syntax-rules.js';
import { textChunkToSpan } from './text-attributes.js';
import type { InkTextStyle } from './theme.js';

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

const NO_STYLE: InkTextStyle = {};

/** Monochrome fallback: one unstyled span per source line. */
export function monochrome(code: string): readonly HighlightedLine[] {
    return code.split('\n').map((line) => ({ spans: [{ text: line, style: NO_STYLE }] }));
}

let initPromise: Promise<void> | null = null;
let syntaxStyle: SyntaxStyle | null = null;
let parsersRegistered = false;

const asyncResultCache = new Map<string, readonly HighlightedLine[]>();
const inFlight = new Map<string, Promise<void>>();

let highlightVersion = 0;
const highlightListeners = new Set<() => void>();

/** Snapshot version for `useSyncExternalStore`; bumps after every async fill. */
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

function cacheKey(filetype: string, code: string): string {
    return `${filetype}\u0000${code}`;
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
function initHighlighter(): Promise<void> {
    if (initPromise !== null) return initPromise;
    initPromise = doInit().catch((error: unknown) => {
        initPromise = null;
        syntaxStyle = null;
        throw error;
    });
    return initPromise;
}

async function doInit(): Promise<void> {
    const client = runtime.getClient();
    await client.setDataPath(runtime.resolveDataPath());
    if (!parsersRegistered) {
        runtime.registerParsers(TREE_SITTER_PARSERS);
        parsersRegistered = true;
    }
    syntaxStyle = runtime.buildSyntaxStyle();
}

// ---------------------------------------------------------------------------
// Async fill
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget an async parse for (code, filetype). Deduplicated against the
 * cache and any in-flight parse for the same key. On success the colored lines
 * are cached, the render LRU is cleared, and listeners are notified. Never
 * throws and never rethrows; failures degrade to monochrome with a stderr log.
 */
function scheduleAsyncHighlight(code: string, filetype: string): void {
    const key = cacheKey(filetype, code);
    if (asyncResultCache.has(key) || inFlight.has(key)) return;

    const task = (async (): Promise<void> => {
        try {
            await initHighlighter();
            const style = syntaxStyle;
            if (style === null) return;
            const client = runtime.getClient();
            const result = await client.highlightOnce(code, filetype);
            if (result.error !== undefined) {
                process.stderr.write(`[tree-sitter-highlighter] highlight error: ${result.error}\n`);
                return;
            }
            const highlights = result.highlights;
            if (highlights === undefined) return;
            const chunks = runtime.toTextChunks(code, highlights, style);
            const lines = chunksToLines(chunks);
            asyncResultCache.set(key, lines);
            clearRenderCache();
            notifyHighlightListeners();
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`[tree-sitter-highlighter] unexpected error: ${message}\n`);
        }
    })();

    inFlight.set(key, task);
    void task.finally(() => {
        inFlight.delete(key);
    });
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
    const cached = asyncResultCache.get(key);
    if (cached !== undefined) return cached;

    try {
        scheduleAsyncHighlight(code, filetype);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[tree-sitter-highlighter] schedule error: ${message}\n`);
    }
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
    try {
        if (syntaxStyle !== null) {
            syntaxStyle.destroy();
            syntaxStyle = null;
        }
        await runtime.destroyClient();
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[tree-sitter-highlighter] close error: ${message}\n`);
    }
    initPromise = null;
    parsersRegistered = false;
}

/**
 * Reset all singleton state for deterministic test isolation: destroys any
 * built style, clears caches/in-flight/listeners, zeroes the version counter,
 * and restores the default runtime.
 */
export function resetHighlighterForTest(): void {
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
    highlightListeners.clear();
    highlightVersion = 0;
    runtime = defaultRuntime;
}
