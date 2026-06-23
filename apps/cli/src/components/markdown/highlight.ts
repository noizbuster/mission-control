/**
 * Tokenizing syntax highlighter for code blocks.
 *
 * cli-highlight 2.1.11 exposes only `highlight()` (returns an ANSI string) and
 * `supportsLanguage()` — there is no structured tokenizer. Worse, its DEFAULT
 * theme emits almost no color, so parsing its ANSI output back into spans would
 * yield a monochrome result.
 *
 * Approach: pass a custom `theme` to `highlight()` whose per-scope formatters
 * do NOT apply chalk. Instead each formatter wraps the token text in private
 * sentinel control characters that carry the scope name:
 *
 *     \x01<scope>\x02<text>\x03
 *
 * cli-highlight nests scopes (e.g. the `function` scope wraps a `keyword`
 * scope wrapping the literal `function` text), so the parser is stack-based:
 * \x01..\x02 pushes a scope, \x03 pops, and each emitted character is tagged
 * with the innermost (most specific) open scope. The scope is then mapped to an
 * `InkTextStyle` via a fixed palette table.
 *
 * Because the custom theme covers every cli-highlight token scope, chalk's SGR
 * formatters never run, so no raw `\x1b[` escapes are produced. A boundary
 * sanitizer strips any stray SGR sequence (e.g. from an unmapped scope in some
 * language) before parsing, guaranteeing no raw ANSI ever reaches a `<Text>`
 * child. Monochrome fallback is used when the language is unsupported, when the
 * source itself contains a sentinel byte, or when cli-highlight throws.
 */

import type { Theme } from 'cli-highlight';
import { highlight, supportsLanguage } from 'cli-highlight';
import type { InkTextStyle } from './theme.js';

/** One styled text fragment produced by the highlighter. */
export type HighlightedSpan = { readonly text: string; readonly style: InkTextStyle };

/** One source line's worth of styled spans. */
export type HighlightedLine = { readonly spans: ReadonlyArray<HighlightedSpan> };

// ---------------------------------------------------------------------------
// Sentinel encoding + scope palette.
// ---------------------------------------------------------------------------

const SCOPE_OPEN = '\x01';
const SCOPE_SEP = '\x02';
const SCOPE_CLOSE = '\x03';
const SENTINEL_CHARS: ReadonlySet<string> = new Set([SCOPE_OPEN, SCOPE_SEP, SCOPE_CLOSE]);

/** Empty style: inherits the renderer's `codeBlock` base. */
const NO_STYLE: InkTextStyle = {};

/**
 * Scope name -> Ink style. Covers the scopes cli-highlight emits for the
 * languages markdown code fences commonly carry. Unknown scopes fall back to
 * {@link NO_STYLE}. Palette is a tasteful dark theme: keywords warm, literals
 * cool, prose dim.
 */
const SCOPE_STYLE_TABLE: ReadonlyMap<string, InkTextStyle> = new Map<string, InkTextStyle>([
    ['keyword', { color: 'magenta' }],
    ['literal', { color: 'cyan' }],
    ['number', { color: 'cyan' }],
    ['built_in', { color: 'cyan' }],
    ['type', { color: 'yellow' }],
    ['class', { color: 'yellow' }],
    ['string', { color: 'green' }],
    ['subst', { color: 'green' }],
    ['regexp', { color: 'cyan' }],
    ['symbol', { color: 'cyan' }],
    ['comment', { color: 'gray', dimColor: true }],
    ['doctag', { color: 'magenta' }],
    ['function', { color: 'blue' }],
    ['title', { color: 'blue' }],
    ['params', NO_STYLE],
    ['meta', { color: 'gray', dimColor: true }],
    ['meta-keyword', { color: 'magenta' }],
    ['meta-string', { color: 'green' }],
    ['section', { color: 'yellow' }],
    ['tag', { color: 'red' }],
    ['name', { color: 'red' }],
    ['attr', { color: 'yellow' }],
    ['attribute', { color: 'yellow' }],
    ['variable', { color: 'red' }],
    ['bullet', NO_STYLE],
    ['selector-tag', { color: 'red' }],
    ['selector-id', { color: 'yellow' }],
    ['selector-class', { color: 'yellow' }],
    ['selector-pseudo', { color: 'cyan' }],
    ['addition', { color: 'green' }],
    ['deletion', { color: 'red' }],
    ['default', NO_STYLE],
]);

function styleForScope(scope: string): InkTextStyle {
    return SCOPE_STYLE_TABLE.get(scope) ?? NO_STYLE;
}

// Every token scope in cli-highlight's `Tokens<T>` plus `default`, each bound to
// a sentinel-wrapping formatter so chalk's ANSI formatters never run.
const SENTINEL_SCOPES = [
    'keyword',
    'built_in',
    'type',
    'literal',
    'number',
    'regexp',
    'string',
    'subst',
    'symbol',
    'class',
    'function',
    'title',
    'params',
    'comment',
    'doctag',
    'meta',
    'meta-keyword',
    'meta-string',
    'section',
    'tag',
    'name',
    'builtin-name',
    'attr',
    'attribute',
    'variable',
    'bullet',
    'code',
    'emphasis',
    'strong',
    'formula',
    'link',
    'quote',
    'selector-tag',
    'selector-id',
    'selector-class',
    'selector-attr',
    'selector-pseudo',
    'template-tag',
    'template-variable',
    'addition',
    'deletion',
] as const;

function wrapWithScope(scope: string): (codePart: string) => string {
    return (codePart) => SCOPE_OPEN + scope + SCOPE_SEP + codePart + SCOPE_CLOSE;
}

const SENTINEL_THEME = {
    ...Object.fromEntries(SENTINEL_SCOPES.map((scope) => [scope, wrapWithScope(scope)])),
    default: wrapWithScope('default'),
} satisfies Theme;

// ---------------------------------------------------------------------------
// Parsing the sentinel stream into spans.
// ---------------------------------------------------------------------------

/** Raw token before newline splitting: text tagged with its scope name. */
type ScopedText = { readonly scope: string; readonly text: string };

/**
 * Walk the sentinel stream, tracking the open-scope stack. Each visible
 * character is tagged with the innermost open scope (innermost wins because
 * cli-highlight wraps narrower scopes inside wider ones, e.g. a `keyword`
 * inside a `function` declaration). Adjacent characters sharing a scope merge
 * into one `ScopedText`.
 */
function parseSentinelStream(input: string): readonly ScopedText[] {
    const tokens: ScopedText[] = [];
    const stack: string[] = [];
    let buffer = '';
    let bufferScope = '';
    const flush = (): void => {
        if (buffer.length > 0) {
            tokens.push({ scope: bufferScope, text: buffer });
            buffer = '';
        }
    };
    let i = 0;
    while (i < input.length) {
        const char = input[i];
        if (char === SCOPE_OPEN) {
            flush();
            i += 1;
            let scope = '';
            while (i < input.length && input[i] !== SCOPE_SEP) {
                scope += input[i];
                i += 1;
            }
            i += 1; // consume SCOPE_SEP
            stack.push(scope);
            bufferScope = scope;
        } else if (char === SCOPE_CLOSE) {
            flush();
            stack.pop();
            bufferScope = stack.length > 0 ? (stack[stack.length - 1] ?? '') : '';
            i += 1;
        } else {
            buffer += char;
            i += 1;
        }
    }
    flush();
    return tokens;
}

/**
 * Split spans at `\n` boundaries into one {@link HighlightedLine} per source
 * line. A span whose text spans a newline is divided across consecutive lines,
 * each fragment keeping the span's style.
 */
function splitSpansIntoLines(spans: readonly ScopedText[]): readonly HighlightedLine[] {
    const lines: HighlightedLine[] = [];
    let current: HighlightedSpan[] = [];
    for (const span of spans) {
        const parts = span.text.split('\n');
        for (let index = 0; index < parts.length; index++) {
            if (index > 0) {
                lines.push({ spans: current });
                current = [];
            }
            const part = parts[index];
            if (part !== undefined && part.length > 0) {
                current.push({ text: part, style: styleForScope(span.scope) });
            }
        }
    }
    lines.push({ spans: current });
    return lines;
}

/** Monochrome fallback: one unstyled span per source line. */
export function monochrome(code: string): readonly HighlightedLine[] {
    return code.split('\n').map((line) => ({ spans: [{ text: line, style: NO_STYLE }] }));
}

function containsSentinel(code: string): boolean {
    for (let i = 0; i < code.length; i++) {
        if (SENTINEL_CHARS.has(code[i] ?? '')) return true;
    }
    return false;
}

/**
 * Highlight `code` as `lang`, returning one {@link HighlightedLine} per source
 * line. Falls back to monochrome when the language is unsupported, the source
 * contains a sentinel byte, or cli-highlight throws. Never throws.
 */
export function highlightCode(code: string, lang?: string): readonly HighlightedLine[] {
    if (containsSentinel(code)) return monochrome(code);
    if (lang !== undefined && !supportsLanguage(lang)) return monochrome(code);
    try {
        const options = lang !== undefined ? { language: lang, theme: SENTINEL_THEME } : { theme: SENTINEL_THEME };
        const wrapped = highlight(code, options);
        // Boundary sanitizer: strip any stray SGR sequence cli-highlight may emit for
        // an unmapped scope, guaranteeing no raw ANSI ever reaches a `<Text>` child.
        // RegExp constructor (not a literal) so the ESC escape stays a string escape
        // rather than a literal control char that would trip noControlCharactersInRegex.
        // biome-ignore lint/complexity/useRegexLiterals: intentional; see comment above.
        const sgrPattern = new RegExp('\\x1b\\[[0-9;]*m', 'g');
        const sanitized = wrapped.replace(sgrPattern, '');
        return splitSpansIntoLines(parseSentinelStream(sanitized));
    } catch {
        return monochrome(code);
    }
}
