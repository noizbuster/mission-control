/**
 * Module-level LRU cache for the markdown block renderer.
 *
 * Extracted from `Markdown.tsx` so the future tree-sitter highlighter can call
 * `clearRenderCache()` on re-tokenization without creating a runtime cycle
 * (`highlight.ts` -> `render-cache.ts` -> `Markdown.tsx` -> ... -> `highlight.ts`).
 *
 * This module has NO runtime dependency on markdown internals: `buildBlocks` is
 * injected into `getCachedBlocks`, so the lookup/store logic stays pure (no
 * `marked` / `tokenToBlocks` import). `RenderBlock` is a type-only import,
 * erased at compile time, so it introduces no runtime edge.
 */

import type { RenderBlock } from './Markdown.js';
import type { TerminalMarkdownTheme } from './theme.js';

/** Maximum entries retained in the render cache (LRU eviction). */
export const CACHE_LIMIT = 64;

const RENDER_CACHE: Map<string, readonly RenderBlock[]> = new Map();

/** Builds rendered blocks from raw markdown (injected to avoid a cycle). */
export type BuildBlocksFn = (
    text: string,
    width: number,
    streaming: boolean,
    theme: TerminalMarkdownTheme,
) => readonly RenderBlock[];

/** Cache key derived from the full input tuple. Stable for identical inputs. */
export function renderCacheKey(text: string, width: number, streaming: boolean, theme: TerminalMarkdownTheme): string {
    const tag = theme.cacheKeyTag ?? 'c';
    return `${tag}:${streaming ? 1 : 0}:${width}:${text}`;
}

/** Clear the render cache. Intended for test isolation. */
export function clearRenderCache(): void {
    RENDER_CACHE.clear();
}

/**
 * Return the rendered blocks for `(text, width, streaming, theme)`, caching the
 * result in a 64-entry LRU keyed on the full input tuple. A repeat call with
 * unchanged input returns the SAME array instance (referential equality).
 */
export function getCachedBlocks(
    text: string,
    width: number,
    streaming: boolean,
    theme: TerminalMarkdownTheme,
    buildBlocks: BuildBlocksFn,
): readonly RenderBlock[] {
    const key = renderCacheKey(text, width, streaming, theme);
    const cached = RENDER_CACHE.get(key);
    if (cached) {
        RENDER_CACHE.delete(key);
        RENDER_CACHE.set(key, cached);
        return cached;
    }
    const blocks = buildBlocks(text, width, streaming, theme);
    RENDER_CACHE.set(key, blocks);
    if (RENDER_CACHE.size > CACHE_LIMIT) {
        const oldest = RENDER_CACHE.keys().next().value;
        if (oldest !== undefined) RENDER_CACHE.delete(oldest);
    }
    return blocks;
}
