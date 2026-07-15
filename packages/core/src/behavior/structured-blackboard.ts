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
 *   (d) single-line string — `explicit`               -> string
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
    const looksJson = fenced !== null || trimmed.startsWith('{') || trimmed.startsWith('[');

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

    if (trimmed === 'true') {
        return validateShape(true, expectedShape);
    }
    if (trimmed === 'false') {
        return validateShape(false, expectedShape);
    }

    if (/[\r\n]/.test(trimmed)) {
        return { ok: false, error: 'structured output must be a single line' };
    }

    return validateShape(trimmed, expectedShape);
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

type ActualStructuredOutputShape = Exclude<StructuredOutputShape, 'any'> | 'null' | 'number';

function shapeOf(value: unknown): ActualStructuredOutputShape {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'string') return 'string';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'number') return 'number';
    return 'object';
}

/** Extract the content of a whole-output markdown fenced code block, or null. */
function extractFencedBlock(text: string): string | null {
    const match = text.match(/^```(?:json)?\r?\n([\s\S]*?)\r?\n```$/);
    return match !== null && match[1] !== undefined ? match[1].trim() : null;
}
