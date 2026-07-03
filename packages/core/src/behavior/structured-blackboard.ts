/**
 * Structured blackboard output parsing for workflow `llm` nodes.
 *
 * A workflow `llm` node may declare `config.outputKey`; when the model's turn
 * produces text, `parseStructuredOutput` turns that text into a typed value
 * (JSON object/array, boolean, or single-line string) that the runner writes to
 * the blackboard under the declared key. Rules then route on
 * `blackboard.value.equals` with structured values instead of fragile
 * first-line strings.
 *
 * The parser is key-agnostic: it validates SHAPE, not key names. The supported
 * key vocabulary is documented in `SUPPORTED_OUTPUT_KEYS`. Invalid structured
 * output FAILS CLOSED ({ ok: false, error }) so the runner can emit a node
 * failure instead of persisting garbage.
 *
 * Supported input forms:
 *   (a) bare JSON   — `{"k":1}` or `[1,2]`           -> parsed object/array
 *   (b) fenced JSON — ```json\n{...}\n```             -> parsed object/array
 *   (c) plain boolean — `true` / `false`              -> boolean
 *   (d) single-line string — `explicit`               -> string (backwards compat)
 *
 * Anything else (malformed JSON, empty output) returns { ok: false, error }.
 */

/** The structural shape a parsed value must satisfy. `'any'` accepts everything. */
export type StructuredOutputShape = 'object' | 'array' | 'boolean' | 'string' | 'any';

export type ParseStructuredOutputResult =
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: string };

/**
 * Documented output-key vocabulary for the built-in workflows. The parser does
 * NOT hardcode these — they are listed for discoverability so workflow authors
 * share one consistent dots-namespaced vocabulary. The parser validates shape,
 * never key names.
 */
export const SUPPORTED_OUTPUT_KEYS = [
    'intent.classification',
    'plan.todos',
    'plan.ready',
    'wave.tasks',
    'wave.pending',
    'delegate.results',
    'verify.complete',
    'checkbox.updated',
    'final.verdict',
] as const;
export type SupportedOutputKey = (typeof SUPPORTED_OUTPUT_KEYS)[number];

/**
 * Parse a model turn's raw text into a structured blackboard value.
 *
 * @param rawText the model's full text output for the turn
 * @param expectedShape optional shape constraint; defaults to `'any'`
 * @returns `{ ok: true, value }` on success, `{ ok: false, error }` otherwise
 */
export function parseStructuredOutput(
    rawText: string,
    expectedShape: StructuredOutputShape = 'any',
): ParseStructuredOutputResult {
    const trimmed = rawText.trim();
    if (trimmed.length === 0) {
        return { ok: false, error: 'empty output' };
    }

    const fenced = extractFencedBlock(trimmed);
    const looksJson = fenced !== null || firstNonWhitespaceIs(trimmed, '{', '[');

    if (looksJson) {
        const candidate = fenced ?? trimmed;
        let parsed: unknown;
        try {
            parsed = JSON.parse(candidate);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: `invalid JSON: ${message}` };
        }
        return validateShape(parsed, expectedShape);
    }

    const lower = trimmed.toLowerCase();
    if (lower === 'true') {
        return validateShape(true, expectedShape);
    }
    if (lower === 'false') {
        return validateShape(false, expectedShape);
    }

    const lastLine = getLastNonEmptyLine(trimmed);
    if (lastLine !== null) {
        const lowerLast = lastLine.toLowerCase();
        if (lowerLast === 'true' || lowerLast === 'yes') {
            return validateShape(true, expectedShape);
        }
        if (lowerLast === 'false' || lowerLast === 'no') {
            return validateShape(false, expectedShape);
        }
        const booleanToken = parseBooleanToken(lowerLast);
        if (booleanToken !== null) {
            return validateShape(booleanToken, expectedShape);
        }
    }

    const stringLine = extractStringLine(trimmed);
    if (stringLine.length === 0) {
        return { ok: false, error: 'empty output' };
    }
    return validateShape(stringLine, expectedShape);
}

/**
 * Recognize natural-language boolean tokens a model commonly emits instead of
 * the literal `true`/`false`. Returns `true`/`false` for an unambiguous token
 * or `null` when the line is not a clean boolean token.
 *
 * Recognized forms (case-insensitive, whole-line match only):
 *   - `yes` / `no`
 *   - `key=true`, `key: true`, `key=false`, `key: false` — the dotted outputKey
 *     assignment pattern (e.g. `guard.cleared=true`)
 */
function parseBooleanToken(line: string): boolean | null {
    if (line === 'yes') return true;
    if (line === 'no') return false;
    const match = line.match(/^[a-z][a-z0-9_.-]*\s*[:=]\s*(true|false|yes|no)$/);
    if (match !== null) {
        const value = match[1];
        if (value === undefined) return null;
        return value === 'true' || value === 'yes';
    }
    return null;
}

function getLastNonEmptyLine(text: string): string | null {
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = (lines[i] ?? '').trim();
        if (line.length > 0) {
            return line;
        }
    }
    return null;
}

function validateShape(value: unknown, expected: StructuredOutputShape): ParseStructuredOutputResult {
    if (expected === 'any') {
        return { ok: true, value };
    }
    const actual = shapeOf(value);
    if (actual === expected) {
        return { ok: true, value };
    }
    return { ok: false, error: `expected shape '${expected}', got '${actual}'` };
}

function shapeOf(value: unknown): Exclude<StructuredOutputShape, 'any'> {
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'string') return 'string';
    if (Array.isArray(value)) return 'array';
    return 'object';
}

/** Extract the content of the first markdown fenced code block, or null. */
function extractFencedBlock(text: string): string | null {
    const match = text.match(/```[^\n]*\n([\s\S]*?)```/);
    return match !== null && match[1] !== undefined ? match[1].trim() : null;
}

/** True when the first non-whitespace character of `text` is one of `chars`. */
function firstNonWhitespaceIs(text: string, ...chars: readonly string[]): boolean {
    for (const ch of text) {
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            continue;
        }
        return chars.includes(ch);
    }
    return false;
}

/**
 * Extract the best string line from multi-line LLM output. Prefers the last
 * non-empty line when it is a clean single token and the first is not.
 */
function extractStringLine(text: string): string {
    const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    if (lines.length === 0) return '';
    const first = lines[0] ?? '';
    if (lines.length === 1) return first;
    const last = lines[lines.length - 1] ?? '';
    if (isCleanToken(last) && !isCleanToken(first)) {
        return last;
    }
    return first;
}

/** A clean classification token: single word, no prose, no markdown markers. */
function isCleanToken(line: string): boolean {
    return (
        line.length > 0 &&
        line.length <= 80 &&
        !line.includes(' ') &&
        !line.includes('**') &&
        !line.includes('`') &&
        !line.includes(':')
    );
}
