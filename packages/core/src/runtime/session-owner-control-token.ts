import type { SessionOwnerControlToken } from '@mission-control/protocol';
import { randomBytes } from 'node:crypto';

export class SessionOwnerControlServerError extends Error {
    readonly code: 'owner_fenced' | 'token_invalid';

    constructor(code: 'owner_fenced' | 'token_invalid') {
        super(code === 'owner_fenced' ? 'session owner is fenced' : 'session owner control token is invalid');
        this.name = 'SessionOwnerControlServerError';
        this.code = code;
    }
}

export function createSessionOwnerControlToken(
    input: Omit<SessionOwnerControlToken, 'value'>,
): SessionOwnerControlToken {
    return { ...input, value: randomBytes(32).toString('base64url') };
}

export function matchesSessionOwnerControlToken(
    left: SessionOwnerControlToken,
    right: SessionOwnerControlToken,
): boolean {
    return (
        left.value === right.value &&
        left.operationId === right.operationId &&
        left.sessionId === right.sessionId &&
        left.kind === right.kind &&
        left.ownerId === right.ownerId &&
        left.ownerEpoch === right.ownerEpoch &&
        left.timeoutMs === right.timeoutMs
    );
}
