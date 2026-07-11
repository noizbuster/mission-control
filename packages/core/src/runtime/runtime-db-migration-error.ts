export const runtimeDbMigrationErrorCodes = [
    'legacy_root_invalid',
    'legacy_db_invalid',
    'legacy_run_corrupt',
    'legacy_run_unsafe',
    'source_db_corrupt',
    'row_collision',
    'ledger_mismatch',
    'transaction_failed',
    'projection_rebuild_failed',
] as const;
export type RuntimeDbMigrationErrorCode = (typeof runtimeDbMigrationErrorCodes)[number];

export class RuntimeDbMigrationError extends Error {
    readonly code: RuntimeDbMigrationErrorCode;
    readonly path?: string;
    readonly table?: string;
    readonly migrationId?: string;

    constructor(input: {
        readonly code: RuntimeDbMigrationErrorCode;
        readonly message: string;
        readonly path?: string;
        readonly table?: string;
        readonly migrationId?: string;
        readonly cause?: unknown;
    }) {
        super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
        this.name = 'RuntimeDbMigrationError';
        this.code = input.code;
        if (input.path !== undefined) this.path = input.path;
        if (input.table !== undefined) this.table = input.table;
        if (input.migrationId !== undefined) this.migrationId = input.migrationId;
    }
}
