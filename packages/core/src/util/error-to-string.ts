/**
 * Shared `unknown` error → string. Centralizes the `instanceof Error ? message : …`
 * pattern duplicated across the codebase, and avoids the `[object Object]` degradation
 * that plain `String(error)` produces for non-Error objects (common for circular
 * network/abort error objects).
 *
 * Prefer this over inline `error instanceof Error ? error.message : String(error)`.
 */
export function errorToString(error: unknown): string {
    if (typeof error === 'string') {
        return error;
    }
    if (error instanceof Error) {
        return error.message;
    }
    if (error !== null && typeof error === 'object' && 'message' in error) {
        const message = (error as { message: unknown }).message;
        if (typeof message === 'string' && message.length > 0) {
            return message;
        }
    }
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}
