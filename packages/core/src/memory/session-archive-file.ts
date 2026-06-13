import {
    type SessionArchiveFile,
    SessionArchiveFileSchema,
    type SessionArchiveManifest,
} from '@mission-control/protocol';
import { createHash } from 'node:crypto';

export type CreateSessionArchiveInput = {
    readonly sessionId: string;
    readonly cwd: string;
    readonly trustedRoot: string;
    readonly createdAt: string;
    readonly eventsJsonl: string;
};

export class SessionArchiveFileError extends Error {
    readonly code: 'invalid_json' | 'invalid_archive' | 'checksum_mismatch';

    constructor(input: {
        readonly code: SessionArchiveFileError['code'];
        readonly message: string;
    }) {
        super(input.message);
        this.name = 'SessionArchiveFileError';
        this.code = input.code;
    }
}

export function createSessionArchive(input: CreateSessionArchiveInput): SessionArchiveFile {
    const manifest: SessionArchiveManifest = {
        schemaVersion: 1,
        sessionId: input.sessionId,
        cwd: input.cwd,
        trustedRoot: input.trustedRoot,
        createdAt: input.createdAt,
    };
    const checksum = checksumFor(input.eventsJsonl);
    return SessionArchiveFileSchema.parse({
        kind: 'mission-control.session-archive',
        version: 1,
        manifest,
        checksum,
        eventsJsonl: input.eventsJsonl,
    });
}

export function parseSessionArchive(contents: string): SessionArchiveFile {
    const parsed = parseArchiveJson(contents);
    const archive = validateArchiveShape(parsed);
    const expectedChecksum = checksumFor(archive.eventsJsonl);
    if (archive.checksum.value !== expectedChecksum.value) {
        throw new SessionArchiveFileError({
            code: 'checksum_mismatch',
            message: 'Session archive checksum does not match the JSONL payload',
        });
    }
    return archive;
}

function parseArchiveJson(contents: string): unknown {
    try {
        return JSON.parse(contents);
    } catch (error: unknown) {
        throw new SessionArchiveFileError({
            code: 'invalid_json',
            message: error instanceof Error ? error.message : 'Session archive is not valid JSON',
        });
    }
}

function validateArchiveShape(value: unknown): SessionArchiveFile {
    const parsed = SessionArchiveFileSchema.safeParse(value);
    if (!parsed.success) {
        throw new SessionArchiveFileError({
            code: 'invalid_archive',
            message: parsed.error.issues.at(0)?.message ?? 'Session archive is invalid',
        });
    }
    return parsed.data;
}

function checksumFor(eventsJsonl: string): SessionArchiveFile['checksum'] {
    return {
        algorithm: 'sha256',
        value: createHash('sha256').update(eventsJsonl).digest('hex'),
    };
}
