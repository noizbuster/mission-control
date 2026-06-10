export const JSONL_SESSION_EVENT_STORE_ERROR_CODES = [
    'invalid_session_id',
    'invalid_event',
    'invalid_sequence',
    'missing_header',
    'invalid_header',
    'corrupt_line',
    'session_mismatch',
    'lock_exists',
    'lock_failed',
    'write_failed',
] as const;

export type JsonlSessionEventStoreErrorCode = (typeof JSONL_SESSION_EVENT_STORE_ERROR_CODES)[number];

export type JsonlSessionEventStoreErrorInput = {
    readonly code: JsonlSessionEventStoreErrorCode;
    readonly message: string;
    readonly sessionId: string;
    readonly path?: string;
    readonly lineNumber?: number;
    readonly cause?: unknown;
};

export class JsonlSessionEventStoreError extends Error {
    readonly code: JsonlSessionEventStoreErrorCode;
    readonly sessionId: string;
    readonly path: string | undefined;
    readonly lineNumber: number | undefined;

    constructor(input: JsonlSessionEventStoreErrorInput) {
        super(input.message, { cause: input.cause });
        this.name = 'JsonlSessionEventStoreError';
        this.code = input.code;
        this.sessionId = input.sessionId;
        this.path = input.path;
        this.lineNumber = input.lineNumber;
    }
}

export function jsonlStoreError(input: JsonlSessionEventStoreErrorInput): JsonlSessionEventStoreError {
    return new JsonlSessionEventStoreError(input);
}
