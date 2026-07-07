export type CliSessionCommandErrorCode =
    | 'invalid_session_id'
    | 'session_not_found'
    | 'session_live_locked'
    | 'unsupported_session_command';

export class CliSessionCommandError extends Error {
    readonly code: CliSessionCommandErrorCode;
    readonly sessionId?: string;

    constructor(input: {
        readonly code: CliSessionCommandErrorCode;
        readonly message: string;
        readonly sessionId?: string;
    }) {
        super(input.message);
        this.name = 'CliSessionCommandError';
        this.code = input.code;
        if (input.sessionId !== undefined) {
            this.sessionId = input.sessionId;
        }
    }
}
