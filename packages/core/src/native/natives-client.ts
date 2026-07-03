import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Environment variable that points at the `mission-control-natives` `.node`
 * artifact. When set, it takes priority over the resolved candidate paths.
 */
const envKey = 'MCTRL_NATIVES_PATH';

/** Shape of the native addon exported by `native/natives`. `search`,
 * `hasMatch`, `glob`, `fuzzyFind`, `summarizeCode`, `astGrep`, `astRewrite`,
 * `htmlToMarkdown`, and `highlightCode` are optional because an addon build
 * from before the respective module landed (task 1's token-only build) exposes
 * only `countTokens`; the client detects their absence and falls back to the
 * TypeScript path. */
export type NativesAddon = {
    readonly countTokens: (text: string, model: string) => number;
    readonly search?: (
        pattern: string,
        paths: readonly string[],
        opts: NativeSearchOptions,
    ) => readonly NativeGrepMatch[];
    readonly hasMatch?: (pattern: string, paths: readonly string[]) => boolean;
    readonly glob?: (pattern: string, root: string, opts: NativeGlobOptions) => readonly string[];
    readonly fuzzyFind?: (query: string, root: string, opts: NativeFuzzyFindOptions) => readonly string[];
    readonly summarizeCode?: (opts: NativeSummaryOptions) => NativeSummaryResult;
    readonly astGrep?: (pattern: string, paths: readonly string[], opts: NativeAstGrepOptions) => NativeAstGrepResult;
    readonly astRewrite?: (
        pattern: string,
        paths: readonly string[],
        opts: NativeAstRewriteOptions,
    ) => readonly NativeAstReplaceChange[];
    readonly htmlToMarkdown?: (html: string, opts?: NativeHtmlToMarkdownOptions) => string;
    readonly highlightCode?: (code: string, lang: string, colors: NativeHighlightColors) => string;
    /** Clear the shared fs scan cache. Optional: an older addon build (before
     * the fs_cache module landed) does not expose it, and the client treats
     * its absence as a silent no-op. */
    readonly invalidateFsScanCache?: () => void;
};

/** One matched line returned by the native `search`. Paths are returned
 * verbatim from the input list (absolute when the caller passes absolute);
 * the TypeScript wrapper converts them to workspace-relative form. */
export type NativeGrepMatch = {
    readonly path: string;
    readonly lineNumber: number;
    readonly lineContent: string;
};

/** Options for the native `search`. Field names mirror the napi-derive
 * camelCase surface of `GrepOptions` in `native/natives/src/grep.rs`. */
export type NativeSearchOptions = {
    readonly include?: string;
    readonly outputMode?: 'content' | 'files_with_matches' | 'count';
    readonly headLimit?: number;
    readonly gitignore?: boolean;
};

/** Options for the native `glob`. Mirrors the camelCase surface of
 * `NativeGlobOptions` in `native/natives/src/glob.rs`. */
export type NativeGlobOptions = {
    readonly maxResults?: number;
    readonly denylist?: readonly string[];
};

/** Options for the native `fuzzyFind`. Mirrors the camelCase surface of
 * `NativeFuzzyFindOptions` in `native/natives/src/fd.rs`. */
export type NativeFuzzyFindOptions = {
    readonly maxResults?: number;
    readonly denylist?: readonly string[];
};

/** Options for the native `summarizeCode`. Mirrors the camelCase surface of
 * `SummaryOptions` in `native/natives/src/summary.rs`. */
export type NativeSummaryOptions = {
    readonly code: string;
    readonly lang?: string;
    readonly path?: string;
    readonly minBodyLines?: number;
    readonly minCommentLines?: number;
    readonly unfoldUntilLines?: number;
    readonly unfoldLimitLines?: number;
};

/** One kept/elided segment of a structural summary. Mirrors `SummarySegment`
 * in `native/natives/src/summary.rs`. */
export type NativeSummarySegment = {
    readonly kind: 'kept' | 'elided';
    readonly startLine: number;
    readonly endLine: number;
    readonly text?: string;
};

/** Structural summary of a source file. Mirrors `SummaryResult` in
 * `native/natives/src/summary.rs`. When `parsed` is false the segments hold
 * the verbatim source and `elided` is false, so the caller can fall back to
 * raw text. */
export type NativeSummaryResult = {
    readonly language?: string;
    readonly parsed: boolean;
    readonly elided: boolean;
    readonly totalLines: number;
    readonly segments: readonly NativeSummarySegment[];
};

/** Options for the native `astGrep`. Mirrors the camelCase surface of
 * `AstGrepOptions` in `native/natives/src/ast.rs`. */
export type NativeAstGrepOptions = {
    readonly lang?: string;
    readonly selector?: string;
    readonly strictness?: 'cst' | 'smart' | 'ast' | 'relaxed' | 'signature';
    readonly includeMeta?: boolean;
    readonly limit?: number;
};

/** One ast-grep match. Positions are 1-indexed to match the TypeScript runner's
 * normalised output. Mirrors `AstMatch` in `native/natives/src/ast.rs`. */
export type NativeAstMatch = {
    readonly path: string;
    readonly text: string;
    readonly startLine: number;
    readonly startColumn: number;
    readonly endLine: number;
    readonly endColumn: number;
    readonly metaVariables?: Readonly<Record<string, string>>;
};

/** Result of the native `astGrep`. Mirrors `AstGrepResult` in
 * `native/natives/src/ast.rs`. */
export type NativeAstGrepResult = {
    readonly matches: readonly NativeAstMatch[];
    readonly filesSearched: number;
    readonly filesWithMatches: number;
    readonly limitReached: boolean;
    readonly parseErrors?: readonly string[];
};

/** Options for the native `astRewrite`. Mirrors `AstRewriteOptions` in
 * `native/natives/src/ast.rs`. */
export type NativeAstRewriteOptions = {
    readonly replacement: string;
    readonly lang?: string;
    readonly selector?: string;
    readonly strictness?: 'cst' | 'smart' | 'ast' | 'relaxed' | 'signature';
    readonly maxReplacements?: number;
};

/** One computed (dry-run) replacement. Mirrors `AstReplaceChange` in
 * `native/natives/src/ast.rs`. The caller decides whether to apply it. */
export type NativeAstReplaceChange = {
    readonly path: string;
    readonly before: string;
    readonly after: string;
    readonly byteStart: number;
    readonly byteEnd: number;
    readonly startLine: number;
    readonly startColumn: number;
    readonly endLine: number;
    readonly endColumn: number;
};

/** Options for the native `htmlToMarkdown`. Mirrors `HtmlToMarkdownOptions`
 * in `native/natives/src/html.rs`. */
export type NativeHtmlToMarkdownOptions = {
    readonly cleanContent?: boolean;
    readonly skipImages?: boolean;
};

/** Theme colors for the native `highlightCode`. Each value is an ANSI escape
 * sequence. `inserted`/`deleted` are optional (diff highlighting). Mirrors
 * `HighlightColors` in `native/natives/src/highlight.rs`. */
export type NativeHighlightColors = {
    readonly comment: string;
    readonly keyword: string;
    readonly function: string;
    readonly variable: string;
    readonly string: string;
    readonly number: string;
    readonly type: string;
    readonly operator: string;
    readonly punctuation: string;
    readonly inserted?: string;
    readonly deleted?: string;
};

/** Sink invoked once when the addon cannot be loaded. */
export type NativesWarningSink = (message: string) => void;

export interface NativesClient {
    /** `true` when the native addon is loaded and ready. */
    readonly available: boolean;
    /**
     * Count tokens for `text` using the BPE table selected by `model`.
     * Returns `null` (never throws) when the addon is unavailable.
     */
    countTokens(text: string, model: string): number | null;
    /**
     * Regex content search over `paths`. Returns the raw match list when the
     * addon is present, or `null` (never throws) when the addon is unavailable
     * or the build predates the grep module, so the caller falls back to the
     * TypeScript search path. Invocation errors (e.g. an unrecoverable regex)
     * also surface as `null` so the fallback handles them gracefully.
     */
    search(pattern: string, paths: readonly string[], opts: NativeSearchOptions): readonly NativeGrepMatch[] | null;
    /** True if any file in `paths` matches `pattern`. `null` when the addon
     * is unavailable or predates the grep module. */
    hasMatch(pattern: string, paths: readonly string[]): boolean | null;
    /**
     * Glob-based path discovery over `root`. Returns workspace-relative
     * paths (using `/` separators) of files matching `pattern`, or `null`
     * when the addon is unavailable or predates the glob module, so the
     * caller falls back to the TypeScript readdir path.
     */
    glob(pattern: string, root: string, opts: NativeGlobOptions): readonly string[] | null;
    /**
     * Fuzzy path discovery over `root`. Returns workspace-relative paths of
     * files whose basename or path fuzzy-matches `query`, or `null` when the
     * addon is unavailable or predates the fd module.
     */
    fuzzyFind(query: string, root: string, opts: NativeFuzzyFindOptions): readonly string[] | null;
    /**
     * Structural source summary of `code` via the tree-sitter grammar
     * selected by `lang` or `path`. Returns `null` (never throws) when the
     * addon is unavailable or predates the summary module, so the caller
     * falls back to raw text. A returned result with `parsed: false` means
     * the language is unsupported or the source did not parse; the segments
     * then hold the verbatim source.
     */
    summarizeCode(opts: NativeSummaryOptions): NativeSummaryResult | null;
    /**
     * Structural ast-grep search over `paths` (caller-vetted absolute file
     * paths). Returns `null` (never throws) when the addon is unavailable or
     * predates the ast module, so the caller falls back to the `sg` binary
     * path. Invocation errors (e.g. an unsupported explicit language) also
     * surface as `null`.
     */
    astGrep(pattern: string, paths: readonly string[], opts: NativeAstGrepOptions): NativeAstGrepResult | null;
    /**
     * Dry-run ast-grep rewrite over `paths`. Returns computed changes without
     * writing files. `null` when the addon is unavailable or predates the ast
     * module.
     */
    astRewrite(
        pattern: string,
        paths: readonly string[],
        opts: NativeAstRewriteOptions,
    ): readonly NativeAstReplaceChange[] | null;
    /**
     * Convert `html` to Markdown. Returns `null` (never throws) when the addon
     * is unavailable or predates the html module, so the caller falls back to
     * the raw body.
     */
    htmlToMarkdown(html: string, opts?: NativeHtmlToMarkdownOptions): string | null;
    /**
     * Syntax-highlight `code` (selected by `lang`) into ANSI-colored text.
     * Returns `null` (never throws) when the addon is unavailable or predates
     * the highlight module.
     */
    highlightCode(code: string, lang: string, colors: NativeHighlightColors): string | null;
    /**
     * Clear the shared filesystem scan cache (mtime-keyed file content cached
     * by grep/read). Intended to be called after every workspace file mutation
     * so the next read sees fresh content. Never throws: when the addon is
     * unavailable or predates the fs_cache module it is a silent no-op, and
     * invocation errors are swallowed (the cache is an optional acceleration,
     * never a hard dependency).
     */
    invalidateFsScanCache(): void;
}

export interface CreateNativesClientOptions {
    /** Explicit path to the `.node` addon. Overrides resolved candidates. */
    readonly addonPath?: string;
    /** Warning sink invoked at most once on load failure. */
    readonly onWarning?: NativesWarningSink;
}

type LoadOutcome = { readonly ok: true; readonly addon: NativesAddon } | { readonly ok: false; readonly error: string };

const moduleDir = dirname(fileURLToPath(import.meta.url));
const addonRequire = createRequire(import.meta.url);

// An explicit addonPath (or env override) is authoritative and never falls
// through to other candidates, so callers and tests can force a specific
// binary or a guaranteed miss.
function resolveAddonPath(explicit?: string): string | null {
    if (explicit !== undefined && explicit.length > 0) {
        return existsSync(explicit) ? explicit : null;
    }
    const envValue = process.env[envKey];
    if (envValue !== undefined && envValue.length > 0) {
        return existsSync(envValue) ? envValue : null;
    }
    for (const root of candidateWorkspaceRoots()) {
        const candidate = join(root, 'native', 'natives', 'index.node');
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

/** Roots to probe for the addon: the process cwd plus ancestors of this module. */
function candidateWorkspaceRoots(): readonly string[] {
    const roots: string[] = [process.cwd()];
    let dir = moduleDir;
    for (let i = 0; i < 10; i += 1) {
        roots.push(dir);
        const parent = dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return roots;
}

function isNativesAddon(value: unknown): value is NativesAddon {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const record = value as Record<string, unknown>;
    // `countTokens` is the loadability signal shared with task 1. `search` and
    // `hasMatch` may be absent on an older addon build; the client checks for
    // them at call time and falls back when missing.
    return typeof record['countTokens'] === 'function';
}

/** Attempt one load; never throws. */
function attemptLoad(options: CreateNativesClientOptions): LoadOutcome {
    const path = resolveAddonPath(options.addonPath);
    if (path === null) {
        return { ok: false, error: 'mission-control-natives addon was not found' };
    }
    try {
        const raw: unknown = addonRequire(path);
        if (!isNativesAddon(raw)) {
            return { ok: false, error: `addon at ${path} did not expose countTokens` };
        }
        return { ok: true, addon: raw };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: `failed to load mission-control-natives addon: ${message}` };
    }
}

/**
 * Create a lazy N-API client for `mission-control-natives`.
 *
 * The `.node` artifact is loaded on first use and the outcome (addon or
 * failure) is cached for the lifetime of the client. When the addon is absent
 * or fails to load, `countTokens` returns `null` and the configured warning
 * sink is invoked exactly once; the run always continues.
 */
export function createNativesClient(options: CreateNativesClientOptions = {}): NativesClient {
    let cached: LoadOutcome | undefined;
    let warningEmitted = false;

    const loadOnce = (): LoadOutcome => {
        if (cached !== undefined) {
            return cached;
        }
        cached = attemptLoad(options);
        if (!cached.ok && !warningEmitted) {
            warningEmitted = true;
            const sink = options.onWarning ?? defaultWarningSink;
            sink(cached.error);
        }
        return cached;
    };

    return {
        get available(): boolean {
            return loadOnce().ok;
        },
        countTokens(text: string, model: string): number | null {
            const outcome = loadOnce();
            if (!outcome.ok) {
                return null;
            }
            try {
                return outcome.addon.countTokens(text, model);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                if (!warningEmitted) {
                    warningEmitted = true;
                    const sink = options.onWarning ?? defaultWarningSink;
                    sink(`countTokens invocation failed: ${message}`);
                }
                return null;
            }
        },
        search(
            pattern: string,
            paths: readonly string[],
            opts: NativeSearchOptions,
        ): readonly NativeGrepMatch[] | null {
            const outcome = loadOnce();
            if (!outcome.ok || outcome.addon.search === undefined) {
                return null;
            }
            // Invocation errors (e.g. an unrecoverable regex) fall back to the
            // TypeScript path silently rather than warning, since the fallback
            // already handles malformed patterns gracefully.
            try {
                return outcome.addon.search(pattern, [...paths], opts);
            } catch {
                return null;
            }
        },
        hasMatch(pattern: string, paths: readonly string[]): boolean | null {
            const outcome = loadOnce();
            if (!outcome.ok || outcome.addon.hasMatch === undefined) {
                return null;
            }
            try {
                return outcome.addon.hasMatch(pattern, [...paths]);
            } catch {
                return null;
            }
        },
        glob(pattern: string, root: string, opts: NativeGlobOptions): readonly string[] | null {
            const outcome = loadOnce();
            if (!outcome.ok || outcome.addon.glob === undefined) {
                return null;
            }
            try {
                return outcome.addon.glob(pattern, root, {
                    ...(opts.maxResults !== undefined ? { maxResults: opts.maxResults } : {}),
                    ...(opts.denylist !== undefined ? { denylist: [...opts.denylist] } : {}),
                });
            } catch {
                return null;
            }
        },
        fuzzyFind(query: string, root: string, opts: NativeFuzzyFindOptions): readonly string[] | null {
            const outcome = loadOnce();
            if (!outcome.ok || outcome.addon.fuzzyFind === undefined) {
                return null;
            }
            try {
                return outcome.addon.fuzzyFind(query, root, {
                    ...(opts.maxResults !== undefined ? { maxResults: opts.maxResults } : {}),
                    ...(opts.denylist !== undefined ? { denylist: [...opts.denylist] } : {}),
                });
            } catch {
                return null;
            }
        },
        summarizeCode(opts: NativeSummaryOptions): NativeSummaryResult | null {
            const outcome = loadOnce();
            if (!outcome.ok || outcome.addon.summarizeCode === undefined) {
                return null;
            }
            try {
                return outcome.addon.summarizeCode({
                    code: opts.code,
                    ...(opts.lang !== undefined ? { lang: opts.lang } : {}),
                    ...(opts.path !== undefined ? { path: opts.path } : {}),
                    ...(opts.minBodyLines !== undefined ? { minBodyLines: opts.minBodyLines } : {}),
                    ...(opts.minCommentLines !== undefined ? { minCommentLines: opts.minCommentLines } : {}),
                    ...(opts.unfoldUntilLines !== undefined ? { unfoldUntilLines: opts.unfoldUntilLines } : {}),
                    ...(opts.unfoldLimitLines !== undefined ? { unfoldLimitLines: opts.unfoldLimitLines } : {}),
                });
            } catch {
                return null;
            }
        },
        astGrep(pattern: string, paths: readonly string[], opts: NativeAstGrepOptions): NativeAstGrepResult | null {
            const outcome = loadOnce();
            if (!outcome.ok || outcome.addon.astGrep === undefined) {
                return null;
            }
            try {
                return outcome.addon.astGrep(pattern, [...paths], {
                    ...(opts.lang !== undefined ? { lang: opts.lang } : {}),
                    ...(opts.selector !== undefined ? { selector: opts.selector } : {}),
                    ...(opts.strictness !== undefined ? { strictness: opts.strictness } : {}),
                    ...(opts.includeMeta !== undefined ? { includeMeta: opts.includeMeta } : {}),
                    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
                });
            } catch {
                return null;
            }
        },
        astRewrite(
            pattern: string,
            paths: readonly string[],
            opts: NativeAstRewriteOptions,
        ): readonly NativeAstReplaceChange[] | null {
            const outcome = loadOnce();
            if (!outcome.ok || outcome.addon.astRewrite === undefined) {
                return null;
            }
            try {
                return outcome.addon.astRewrite(pattern, [...paths], {
                    replacement: opts.replacement,
                    ...(opts.lang !== undefined ? { lang: opts.lang } : {}),
                    ...(opts.selector !== undefined ? { selector: opts.selector } : {}),
                    ...(opts.strictness !== undefined ? { strictness: opts.strictness } : {}),
                    ...(opts.maxReplacements !== undefined ? { maxReplacements: opts.maxReplacements } : {}),
                });
            } catch {
                return null;
            }
        },
        htmlToMarkdown(html: string, opts?: NativeHtmlToMarkdownOptions): string | null {
            const outcome = loadOnce();
            if (!outcome.ok || outcome.addon.htmlToMarkdown === undefined) {
                return null;
            }
            try {
                if (opts === undefined) {
                    return outcome.addon.htmlToMarkdown(html);
                }
                return outcome.addon.htmlToMarkdown(html, {
                    ...(opts.cleanContent !== undefined ? { cleanContent: opts.cleanContent } : {}),
                    ...(opts.skipImages !== undefined ? { skipImages: opts.skipImages } : {}),
                });
            } catch {
                return null;
            }
        },
        highlightCode(code: string, lang: string, colors: NativeHighlightColors): string | null {
            const outcome = loadOnce();
            if (!outcome.ok || outcome.addon.highlightCode === undefined) {
                return null;
            }
            try {
                return outcome.addon.highlightCode(code, lang, {
                    comment: colors.comment,
                    keyword: colors.keyword,
                    function: colors.function,
                    variable: colors.variable,
                    string: colors.string,
                    number: colors.number,
                    type: colors.type,
                    operator: colors.operator,
                    punctuation: colors.punctuation,
                    ...(colors.inserted !== undefined ? { inserted: colors.inserted } : {}),
                    ...(colors.deleted !== undefined ? { deleted: colors.deleted } : {}),
                });
            } catch {
                return null;
            }
        },
        invalidateFsScanCache(): void {
            const outcome = loadOnce();
            if (!outcome.ok || outcome.addon.invalidateFsScanCache === undefined) {
                return;
            }
            try {
                outcome.addon.invalidateFsScanCache();
            } catch {
                // The cache is an optional acceleration; a failure to
                // invalidate must never break the caller's mutation. The
                // mtime-keyed cache would self-correct on the next read
                // anyway (a mutated file has a new mtime = miss).
            }
        },
    };
}

function defaultWarningSink(message: string): void {
    console.warn(`[native.warning] ${message}`);
}
