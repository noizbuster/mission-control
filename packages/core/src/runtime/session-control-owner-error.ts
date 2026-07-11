export type SessionControlOwnerErrorCode =
    | 'authentication_failed'
    | 'owner_unreachable'
    | 'registry_forged'
    | 'stale_owner_still_active';

export class SessionControlOwnerError extends Error {
    readonly code: SessionControlOwnerErrorCode;

    constructor(code: SessionControlOwnerErrorCode, message: string, cause?: unknown) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'SessionControlOwnerError';
        this.code = code;
    }
}
