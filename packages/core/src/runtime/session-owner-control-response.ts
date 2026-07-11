import { SESSION_OWNER_CONTROL_PROTOCOL_VERSION } from '@mission-control/protocol';
import type { EventEmitter } from 'node:events';

export function trackSessionOwnerControlStopResponse(
    connection: Pick<EventEmitter, 'once'>,
    finish: () => void,
): () => void {
    let pending = true;
    const complete = (): void => {
        if (!pending) return;
        pending = false;
        finish();
    };
    connection.once('close', complete);
    return complete;
}

export function sessionOwnerControlRequestId(value: unknown): string {
    if (
        typeof value === 'object' &&
        value !== null &&
        'id' in value &&
        typeof value.id === 'string' &&
        value.id.length > 0
    ) {
        return value.id;
    }
    return 'invalid';
}

export function sessionOwnerControlErrorResponse(
    id: string,
    code: 'invalid_request' | 'internal_error' | 'owner_fenced' | 'token_invalid',
    message?: string,
) {
    return {
        version: SESSION_OWNER_CONTROL_PROTOCOL_VERSION,
        id,
        ok: false,
        error: { code, message: message ?? 'session owner control request is invalid' },
    } as const;
}
