/**
 * Shared JSONC resource loader used by workflow and plugin discovery.
 *
 * Owns the never-throws pipeline that both loaders duplicate: denylist check →
 * stat (drop on miss) → size cap → read → strip JSONC comments → JSON.parse →
 * schema validation. Callers supply the schema, the fallback resource name,
 * the file path to load, and a diagnostic factory that maps each failure stage
 * to the loader's own diagnostic shape — preserving per-loader message wording,
 * name field (`workflowName` vs `pluginName`), and path field exactly.
 *
 * `jsoncDiagnosticFields` factors out the severity+message mapping shared by the
 * diagnostic-returning loaders (they differ only in the size-bound noun).
 */
import { type ZodType } from 'zod';
import { errorToString } from '../util/error-to-string';
import { stripJsoncComments } from '../workflows/jsonc-parser';
import { absolutePathMatchesDenylist } from './index';
import { readFile, stat } from 'node:fs/promises';

export type JsoncLoadOutcome<T, D> =
    | { readonly kind: 'loaded'; readonly data: T }
    | { readonly kind: 'diagnostic'; readonly diagnostic: D }
    | { readonly kind: 'drop' };

export type JsoncLoadStage = 'denylisted' | 'size_exceeded' | 'read_failed' | 'parse_error' | 'validation_error';

export type JsoncLoadFailure =
    | { readonly stage: 'denylisted'; readonly name: string }
    | {
          readonly stage: 'size_exceeded';
          readonly name: string;
          readonly size: number;
          readonly maxFileBytes: number;
      }
    | { readonly stage: 'read_failed'; readonly name: string; readonly error: unknown }
    | { readonly stage: 'parse_error'; readonly name: string; readonly error: unknown }
    | { readonly stage: 'validation_error'; readonly name: string; readonly issues: string };

export interface LoadJsoncResourceConfig<T, D> {
    /** Absolute file path to stat and read. */
    readonly filePath: string;
    readonly maxFileBytes: number;
    readonly schema: ZodType<T>;
    /** Fallback resource name when the parsed value has no `name` field. */
    readonly fallbackName: string;
    /**
     * Maps a failure to a diagnostic outcome. Owns the diagnostic object shape
     * (name field, path field) so each loader preserves its exact behavior.
     */
    readonly toDiagnostic: (failure: JsoncLoadFailure) => { readonly kind: 'diagnostic'; readonly diagnostic: D };
}

/**
 * Run the shared JSONC load pipeline for `config.filePath`.
 *
 * Never throws: stat misses yield `{ kind: 'drop' }`; every other failure is
 * routed through `toDiagnostic`. A successful parse+validate yields
 * `{ kind: 'loaded', data }`.
 */
export async function loadJsoncResource<T, D>(config: LoadJsoncResourceConfig<T, D>): Promise<JsoncLoadOutcome<T, D>> {
    const { filePath, maxFileBytes, schema, fallbackName, toDiagnostic } = config;

    if (absolutePathMatchesDenylist(filePath)) {
        return toDiagnostic({ stage: 'denylisted', name: fallbackName });
    }
    let stats: { readonly size: number };
    try {
        stats = await stat(filePath);
    } catch {
        return { kind: 'drop' };
    }
    if (stats.size > maxFileBytes) {
        return toDiagnostic({
            stage: 'size_exceeded',
            name: fallbackName,
            size: stats.size,
            maxFileBytes,
        });
    }
    let contents: string;
    try {
        contents = await readFile(filePath, 'utf8');
    } catch (error: unknown) {
        return toDiagnostic({ stage: 'read_failed', name: fallbackName, error });
    }
    const stripped = stripJsoncComments(contents);
    let parsed: unknown;
    try {
        parsed = JSON.parse(stripped);
    } catch (error: unknown) {
        return toDiagnostic({ stage: 'parse_error', name: fallbackName, error });
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
        const name = readNameField(parsed, fallbackName);
        const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
        return toDiagnostic({ stage: 'validation_error', name, issues });
    }
    return { kind: 'loaded', data: result.data };
}

/**
 * Shared severity+message mapping for the diagnostic-returning loaders. They
 * agree on severities and on every message except the size-bound noun
 * (`sizeNoun` — "file" for workflows, "manifest" for plugins). `code` is the
 * failure stage verbatim (`failure.stage`).
 */
export function jsoncDiagnosticFields(
    failure: JsoncLoadFailure,
    sizeNoun: string,
): { readonly severity: 'error' | 'warning'; readonly message: string } {
    switch (failure.stage) {
        case 'denylisted':
            return { severity: 'warning', message: 'path matches the discovery denylist' };
        case 'size_exceeded':
            return {
                severity: 'warning',
                message: `${sizeNoun} exceeds size bound (${failure.size} > ${failure.maxFileBytes} bytes)`,
            };
        case 'read_failed':
            return { severity: 'error', message: `read failed: ${errorToString(failure.error)}` };
        case 'parse_error':
            return { severity: 'error', message: `JSON parse failed: ${errorToString(failure.error)}` };
        case 'validation_error':
            return { severity: 'error', message: `schema validation failed: ${failure.issues}` };
    }
}

function readNameField(value: unknown, fallback: string): string {
    if (typeof value === 'object' && value !== null && 'name' in value) {
        const candidate = (value as { readonly name?: unknown }).name;
        if (typeof candidate === 'string' && candidate.length > 0) {
            return candidate;
        }
    }
    return fallback;
}
