import type { Value } from '@libsql/client';
import { type Run, RunSchema } from '@mission-control/protocol';
import { ZodError } from 'zod';
import { RuntimeDbMigrationError } from './runtime-db-migration-error.js';
import { readDirectLegacyRunFile, requireDirectLegacyDirectory } from './runtime-db-migration-file-safety.js';
import {
    realpathNative,
    type SessionStoreIdentity,
    sessionStoreDatabasePath,
    sessionStoreIdentityFromCanonicalDatabasePath,
} from './session-store-identity.js';
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const JSON_RUNS_PATH = ['.omo', 'runs'] as const;
const JSON_FILE_SUFFIX = '.json';
const EMPTY_RUN_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export type LegacyRunSource = {
    readonly path: string;
    readonly fileUrl: string;
    readonly checksum: string;
    readonly run: Run;
    readonly row: Readonly<Record<string, Value>>;
};

export type LegacyDatabaseSource = {
    readonly path: string;
    readonly fileUrl: string;
    readonly identity: string;
};

export type LegacyRuntimeSource = {
    readonly rootPath: string;
    readonly rootFileUrl: string;
    readonly database?: LegacyDatabaseSource;
    readonly runs: readonly LegacyRunSource[];
    readonly legacyDbIdentity: string;
    readonly migrationId: string;
};

export async function discoverLegacyRuntimeSource(
    root: string,
    canonicalIdentity: SessionStoreIdentity,
): Promise<LegacyRuntimeSource> {
    const rootDetails = await optionalLstat(root);
    if (rootDetails !== undefined && !rootDetails.isDirectory()) {
        throw new RuntimeDbMigrationError({
            code: 'legacy_root_invalid',
            path: root,
            message: `Legacy runtime root is not a directory: ${root}`,
        });
    }
    const rootPath = rootDetails === undefined ? resolve(root) : await realpathNative(root);
    const rootFileUrl = pathToFileURL(rootPath).href;
    const database = await discoverLegacyDatabase(rootPath, canonicalIdentity);
    const runs = await discoverLegacyRuns(rootPath);
    const legacyDbIdentity = database?.identity ?? sha256(rootFileUrl);
    return {
        rootPath,
        rootFileUrl,
        ...(database !== undefined ? { database } : {}),
        runs,
        legacyDbIdentity,
        migrationId: `runtime-db-unification-v1:${legacyDbIdentity}`,
    };
}

async function discoverLegacyDatabase(
    rootPath: string,
    canonicalIdentity: SessionStoreIdentity,
): Promise<LegacyDatabaseSource | undefined> {
    const candidate = sessionStoreDatabasePath(rootPath);
    const candidateDetails = await optionalLstat(candidate);
    if (candidateDetails === undefined) {
        return undefined;
    }
    if (!candidateDetails.isFile()) {
        throw new RuntimeDbMigrationError({
            code: 'legacy_db_invalid',
            path: candidate,
            message: `Legacy runtime database must be a direct regular file: ${candidate}`,
        });
    }
    let databasePath: string;
    try {
        databasePath = await realpathNative(candidate);
    } catch (error: unknown) {
        throw new RuntimeDbMigrationError({
            code: 'legacy_db_invalid',
            path: candidate,
            message: `Legacy runtime database is not a readable file: ${candidate}`,
            cause: error,
        });
    }
    const identity = sessionStoreIdentityFromCanonicalDatabasePath(databasePath);
    if (identity.dbIdentity === canonicalIdentity.dbIdentity) {
        return undefined;
    }
    return { path: databasePath, fileUrl: identity.databaseFileUrl, identity: identity.dbIdentity };
}

async function discoverLegacyRuns(rootPath: string): Promise<readonly LegacyRunSource[]> {
    const omoDir = resolve(rootPath, JSON_RUNS_PATH[0]);
    const runsDir = resolve(rootPath, ...JSON_RUNS_PATH);
    if (!(await requireDirectLegacyDirectory(omoDir))) return [];
    if (!(await requireDirectLegacyDirectory(runsDir))) return [];
    let entries: readonly string[];
    try {
        entries = await readdir(runsDir);
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) return [];
        throw error;
    }
    const paths = entries
        .filter((entry) => entry.endsWith(JSON_FILE_SUFFIX))
        .map((entry) => resolve(runsDir, entry))
        .sort(compareUtf8);
    const runs: LegacyRunSource[] = [];
    for (const path of paths) {
        const bytes = await readDirectLegacyRunFile(path);
        const contents = decodeUtf8(bytes, path);
        let parsed: unknown;
        try {
            parsed = JSON.parse(contents);
        } catch (error: unknown) {
            throw corruptRunError(path, error);
        }
        let run: Run;
        try {
            run = RunSchema.parse(parsed);
        } catch (error: unknown) {
            if (!(error instanceof ZodError)) throw error;
            throw corruptRunError(path, error);
        }
        runs.push({
            path,
            fileUrl: pathToFileURL(path).href,
            checksum: createHash('sha256').update(bytes).digest('hex'),
            run,
            row: rowForLegacyRun(run),
        });
    }
    return runs;
}

function rowForLegacyRun(run: Run): Readonly<Record<string, Value>> {
    const createdAt = run.startedAt ?? run.endedAt ?? EMPTY_RUN_TIMESTAMP;
    const updatedAt = run.endedAt ?? run.startedAt ?? EMPTY_RUN_TIMESTAMP;
    return {
        run_id: run.id,
        mission_id: run.missionId,
        parent_run_id: run.parentRunId ?? null,
        session_id: run.sessionId ?? null,
        child_agent_kind: run.childKind ?? null,
        child_agent_id: run.childAgentId ?? null,
        child_session_ids_json: JSON.stringify(run.childSessionIds ?? []),
        retry_state_json: JSON.stringify(run.taskRetryState ?? {}),
        status: run.status,
        prompt: run.prompt ?? null,
        created_at: createdAt,
        updated_at: updatedAt,
        started_at: run.startedAt ?? null,
        ended_at: run.endedAt ?? null,
        completed_at: run.status === 'completed' ? (run.endedAt ?? null) : null,
        failed_at: run.status === 'failed' ? (run.endedAt ?? null) : null,
        cancelled_at: run.status === 'cancelled' ? (run.endedAt ?? null) : null,
        passthrough_json: JSON.stringify(run),
    };
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error: unknown) {
        throw corruptRunError(path, error);
    }
}

function corruptRunError(path: string, cause: unknown): RuntimeDbMigrationError {
    return new RuntimeDbMigrationError({
        code: 'legacy_run_corrupt',
        path,
        message: `Legacy run source is corrupt or invalid: ${path}`,
        cause,
    });
}

function compareUtf8(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

async function optionalLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
    try {
        return await lstat(path);
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) return undefined;
        throw error;
    }
}

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
