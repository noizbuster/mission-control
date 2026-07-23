const MILLISECONDS_PER_SECOND = 1_000;

export function formatAgentRetryCountdown(retryAt: number, now: number): string | undefined {
    const remainingMs = retryAt - now;
    if (remainingMs <= 0) return undefined;
    return `Retrying in ${Math.ceil(remainingMs / MILLISECONDS_PER_SECOND)}s`;
}
