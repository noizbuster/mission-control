/**
 * Shared record guards for `packages/core` (consolidated from per-module copies).
 *
 * `isRecord` is the canonical STRICT guard: a non-null object that is NOT an array.
 * `isRecordOrArray` is the explicitly-named array-INCLUSIVE variant, kept for modules
 * whose original local guard admitted arrays and where that leniency is load-bearing
 * (each such use carries a comment saying why).
 *
 * Both default to narrowing `Record<string, unknown>` (bracket access is the repo
 * convention under `noPropertyAccessFromIndexSignature`). Pass an explicit candidate
 * type (`isRecord<MyCandidate>(value)`) when a call site wants dot access on optional
 * `unknown` fields — the candidate's fields still require their own `typeof` checks.
 */

/** Strict guard: non-null object that is NOT an array. */
export function isRecord<T extends object = Record<string, unknown>>(value: unknown): value is T {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Array-inclusive guard: any non-null object, arrays included.
 *
 * Reserved for modules whose previous local guard was array-inclusive AND where that
 * behavior is observable at a call site (fallback-chain discrimination, error-text
 * fidelity). Prefer {@linkcode isRecord} for new code.
 */
export function isRecordOrArray<T extends object = Record<string, unknown>>(value: unknown): value is T {
    return typeof value === 'object' && value !== null;
}
