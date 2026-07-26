import type { ZodType } from 'zod';
import { JsonCompatibilityFileError, readCompatibilityJsonFile } from '../../persistence/json-compatibility-file';

/**
 * Constructs a store-specific error (`MissionStoreError` or `RunStoreError`)
 * from a message, code, optional path, and optional cause. Both classes share
 * the `McPersistenceError(message, code, path?, cause?)` signature.
 */
export type CompatibilityRecordErrorBuilder<E extends Error = Error> = (
    message: string,
    code: string,
    path?: string,
    cause?: unknown,
) => E;

/**
 * Per-store code translation for each {@link JsonCompatibilityFileError}
 * variant. The non-`JsonCompatibilityFileError` fallback reuses `readFailed`.
 */
export type CompatibilityRecordCodes = {
    readonly invalidId: string;
    readonly notFound: string;
    readonly unsafeSource: string;
    readonly readFailed: string;
};

/**
 * Map a {@link JsonCompatibilityFileError} (or any unexpected throw from the
 * compatibility file layer) into the store-specific error class. The four
 * canonical file-error codes are translated via `codes`; anything that is not
 * a {@link JsonCompatibilityFileError} becomes a generic read-failed error.
 *
 * Shared by the Mission and Run stores so their error messages and codes stay
 * in lockstep; only the error class, noun, and code strings differ.
 */
export function mapJsonCompatibilityFileError<E extends Error>(
    error: unknown,
    id: string,
    opts: {
        readonly toError: CompatibilityRecordErrorBuilder<E>;
        readonly codes: CompatibilityRecordCodes;
        readonly entityNoun: string;
    },
): E {
    if (!(error instanceof JsonCompatibilityFileError)) {
        return opts.toError(`Failed to read ${opts.entityNoun} ${id}`, opts.codes.readFailed, undefined, error);
    }
    switch (error.code) {
        case 'invalid_id':
            return opts.toError(
                `Invalid ${opts.entityNoun} id ${JSON.stringify(id)}`,
                opts.codes.invalidId,
                error.path,
                error,
            );
        case 'not_found':
            return opts.toError(`${opts.entityNoun} ${id} not found`, opts.codes.notFound, error.path, error);
        case 'unsafe_source':
            return opts.toError(
                `${opts.entityNoun} ${id} is not a safe regular file`,
                opts.codes.unsafeSource,
                error.path,
                error,
            );
        case 'read_failed':
            return opts.toError(`Failed to read ${opts.entityNoun} ${id}`, opts.codes.readFailed, error.path, error);
    }
}

/**
 * Read, parse, and validate a compatibility JSON record. Shared by the Mission
 * and Run stores; the store-specific error class, codes, entity noun, schema,
 * and read-error mapper are supplied by the caller so error messages, codes,
 * paths, and cause-chaining match the pre-refactor output byte-for-byte.
 *
 * Pipeline: `readCompatibilityJsonFile` → `JSON.parse` (`corruptCode` on throw)
 * → `schema.safeParse` (`corruptCode` on failure, cause = the ZodError) →
 * id-match check (`corruptCode` on mismatch, no cause) → optional `transform`
 * → return.
 *
 * The DB-writeback orchestration (canonical-row-first, then persist the legacy
 * record) is intentionally NOT part of this helper — it lives in each store's
 * `read*`/`list*` entrypoint so the per-store asymmetries are preserved.
 */
export async function readCompatibilityRecord<T extends { readonly id: string }>(opts: {
    readonly root: string;
    readonly dir: string;
    readonly id: string;
    readonly filePath: string;
    readonly schema: ZodType<T>;
    readonly toError: CompatibilityRecordErrorBuilder;
    readonly corruptCode: string;
    readonly entityNoun: string;
    readonly mapReadError: (error: unknown) => Error;
    readonly transform?: (record: T) => T;
}): Promise<T> {
    let contents: string;
    try {
        contents = await readCompatibilityJsonFile(opts.root, opts.dir, opts.id);
    } catch (error: unknown) {
        throw opts.mapReadError(error);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(contents);
    } catch (error: unknown) {
        throw opts.toError(
            `${opts.entityNoun} ${opts.id} at ${opts.filePath} is not valid JSON`,
            opts.corruptCode,
            opts.filePath,
            error,
        );
    }

    const result = opts.schema.safeParse(parsed);
    if (!result.success) {
        const firstIssue = result.error.issues[0]?.message ?? 'unknown schema issue';
        throw opts.toError(
            `${opts.entityNoun} ${opts.id} at ${opts.filePath} failed validation: ${firstIssue}`,
            opts.corruptCode,
            opts.filePath,
            result.error,
        );
    }
    if (result.data.id !== opts.id) {
        throw opts.toError(
            `${opts.entityNoun} ${opts.id} at ${opts.filePath} has a mismatched id`,
            opts.corruptCode,
            opts.filePath,
        );
    }
    return opts.transform ? opts.transform(result.data) : result.data;
}
