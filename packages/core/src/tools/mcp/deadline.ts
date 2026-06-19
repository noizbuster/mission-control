/**
 * Shared deadline racing for MCP clients. Both `StdioMcpClient` (stdio child process) and
 * `RemoteMcpClient` (Streamable HTTP + SSE) MUST bound every transport call against a deadline.
 * A hung endpoint that accepts the connection but never replies would otherwise block the eager
 * connect at session start; the deadline turns that hang into a clean retryable failure.
 *
 * The helper races the caller's promise against a timer. On expiry it aborts the in-flight
 * request (via the supplied `AbortSignal`) and rejects with `McpDeadline`. The caller decides
 * what to do on timeout (tear down the child / close the transport, wrap into a
 * `ToolExecutionError`) — this module is transport-agnostic so it can be shared.
 */

/** Default deadline mirroring the sidecar 5000ms precedent (README "Native Fallback"). */
export const DEFAULT_MCP_TIMEOUT_MS = 5000;

/**
 * Error thrown when a transport call exceeds its deadline. Callers catch this (via
 * `instanceof McpDeadline`) to tear down the underlying transport and wrap into a retryable
 * `ToolExecutionError`. The class is exported so callers can distinguish a deadline from an
 * ordinary transport error after the race.
 */
export class McpDeadline extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'McpDeadline';
    }
}

/**
 * Race a transport call against a deadline. The `run` callback receives an `AbortSignal` that
 * fires when the deadline expires so the SDK can cancel the in-flight request promptly; the
 * `Promise.race` is the backstop so a transport that swallows the abort still surfaces at the
 * deadline.
 *
 * On expiry this rejects with `McpDeadline` (it does NOT tear down the transport — that is the
 * caller's job, since teardown differs per transport). On normal completion or a non-deadline
 * rejection, the original value/error propagates unchanged. The timer is always cleared.
 */
export async function raceWithDeadline<T>(
    label: string,
    deadlineMs: number,
    run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    const controller = new AbortController();
    const deadline = new McpDeadline(`${label} exceeded ${deadlineMs}ms deadline`);
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timerId = setTimeout(() => {
            controller.abort();
            reject(deadline);
        }, deadlineMs);
    });
    const runPromise = run(controller.signal);
    runPromise.catch(() => {
        // Attach a handler so an orphaned rejection after the race loses does not surface as an
        // unhandled-rejection warning (teardown may reject the in-flight call out from under it).
    });
    try {
        return await Promise.race([runPromise, timeout]);
    } finally {
        if (timerId !== undefined) {
            clearTimeout(timerId);
        }
    }
}
