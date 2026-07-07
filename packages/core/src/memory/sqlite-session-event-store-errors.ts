export const sqliteSessionEventStoreErrorCodes = [
    'invalid_event',
    'invalid_sequence',
    'session_mismatch',
    'duplicate_event_id',
    'write_failed',
] as const;
export type SqliteSessionEventStoreErrorCode = (typeof sqliteSessionEventStoreErrorCodes)[number];

export class SqliteSessionEventStoreError extends Error {
    readonly code: SqliteSessionEventStoreErrorCode;
    readonly sessionId: string;

    constructor(input: {
        readonly code: SqliteSessionEventStoreErrorCode;
        readonly sessionId: string;
        readonly message: string;
        readonly cause?: unknown;
    }) {
        super(input.message, { cause: input.cause });
        this.name = 'SqliteSessionEventStoreError';
        this.code = input.code;
        this.sessionId = input.sessionId;
    }
}
