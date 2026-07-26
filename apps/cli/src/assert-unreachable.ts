/**
 * Exhaustiveness guard for `switch` / `if` ladders over a discriminated union.
 *
 * Call with the value that TypeScript has narrowed to `never`, plus an optional
 * domain label, so the thrown message reads `Unexpected <label>: <value>` (or
 * `Unexpected value: <value>` when no label is supplied). This replaces the
 * per-module `assertNever` helpers that duplicated this exact shape across the
 * CLI command files.
 */
export function assertUnreachable(value: never, label?: string): never {
    throw new Error(
        label !== undefined ? `Unexpected ${label}: ${String(value)}` : `Unexpected value: ${String(value)}`,
    );
}
