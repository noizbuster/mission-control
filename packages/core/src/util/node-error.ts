/**
 * Shared Node.js error-code guards.
 *
 * `isNodeError`/`isErrorCode` were reimplemented ~24× across persistence, runtime,
 * tools, permission, trust, db, and tui-stores modules — all checking whether a
 * thrown value carries a specific `code` property (e.g. `'ENOENT'`, `'EEXIST'`).
 * This canonical form uses the permissive `typeof object` check (matching the
 * majority of copies) so non-Error throwables that still carry a `code` field are
 * recognized; it does NOT require an `Error` instance, since Node system errors
 * thrown from native bindings are sometimes plain objects.
 */
export function isNodeError(error: unknown, code: string): error is { readonly code: string } {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** Boolean alias of {@link isNodeError} for callers that do not need the narrowing. */
export function isErrorCode(error: unknown, code: string): boolean {
    return isNodeError(error, code);
}

/** True when `error` is a Node "no such file or directory" (`ENOENT`) failure. */
export function isMissingPathError(error: unknown): boolean {
    return isErrorCode(error, 'ENOENT');
}
