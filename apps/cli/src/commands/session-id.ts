const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function parseCliSessionId(sessionId: string): string | undefined {
    return SESSION_ID_PATTERN.test(sessionId) ? sessionId : undefined;
}
