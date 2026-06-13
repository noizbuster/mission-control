import {
    SESSION_ARCHIVE_SCHEMA_VERSION,
    type SessionArchiveManifest,
    SessionArchiveManifestSchema,
} from '@mission-control/protocol';

export type SessionArchiveValidationErrorCode =
    | 'unsupported_schema_version'
    | 'invalid_manifest'
    | 'session_mismatch'
    | 'cwd_mismatch'
    | 'trusted_root_mismatch';

export class SessionArchiveValidationError extends Error {
    readonly code: SessionArchiveValidationErrorCode;

    constructor(input: { readonly code: SessionArchiveValidationErrorCode; readonly message: string }) {
        super(input.message);
        this.name = 'SessionArchiveValidationError';
        this.code = input.code;
    }
}

export function validateSessionArchiveManifestForImport(input: {
    readonly manifest: unknown;
    readonly expectedSessionId: string;
    readonly expectedCwd: string;
    readonly trustedRoot: string;
}): SessionArchiveManifest {
    if (schemaVersionOf(input.manifest) !== SESSION_ARCHIVE_SCHEMA_VERSION) {
        throw new SessionArchiveValidationError({
            code: 'unsupported_schema_version',
            message: `Session archive schema version must be ${SESSION_ARCHIVE_SCHEMA_VERSION}`,
        });
    }

    const parsed = SessionArchiveManifestSchema.safeParse(input.manifest);
    if (!parsed.success) {
        throw new SessionArchiveValidationError({
            code: 'invalid_manifest',
            message: parsed.error.issues.at(0)?.message ?? 'Session archive manifest is invalid',
        });
    }

    const manifest = parsed.data;
    if (manifest.sessionId !== input.expectedSessionId) {
        throw new SessionArchiveValidationError({
            code: 'session_mismatch',
            message: `Session archive belongs to ${manifest.sessionId}, not ${input.expectedSessionId}`,
        });
    }
    if (manifest.cwd !== input.expectedCwd) {
        throw new SessionArchiveValidationError({
            code: 'cwd_mismatch',
            message: `Session archive cwd ${manifest.cwd} does not match ${input.expectedCwd}`,
        });
    }
    if (manifest.trustedRoot !== input.trustedRoot) {
        throw new SessionArchiveValidationError({
            code: 'trusted_root_mismatch',
            message: `Session archive trusted root ${manifest.trustedRoot} does not match ${input.trustedRoot}`,
        });
    }
    return manifest;
}

function schemaVersionOf(value: unknown): unknown {
    if (!isRecord(value)) {
        return undefined;
    }
    return value.schemaVersion;
}

function isRecord(value: unknown): value is { readonly schemaVersion?: unknown } {
    return typeof value === 'object' && value !== null;
}
