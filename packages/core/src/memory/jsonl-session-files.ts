import type { AgentEventEnvelope } from '@mission-control/protocol';
import { SessionEventLog } from '../session-log.js';
import { type DataDirResolutionOptions, resolveMissionControlDataDir } from './data-dir.js';
import { JsonlSessionEventStoreError, jsonlStoreError } from './jsonl-errors.js';
import { createJsonlSessionLogHeader, parseJsonlSessionLog, serializeJsonlRecord } from './jsonl-session-records.js';
import { type FileHandle, mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export type OpenJsonlSessionFileOptions = DataDirResolutionOptions & {
    readonly sessionId: string;
    readonly dataDir?: string;
    readonly now: () => string;
};

export type OpenedJsonlSessionFile = {
    readonly sessionId: string;
    readonly filePath: string;
    readonly lockPath: string;
    readonly fileHandle: FileHandle;
    readonly lockHandle: FileHandle;
    readonly log: SessionEventLog;
    readonly nextSequence: number;
};

export async function openJsonlSessionFile(options: OpenJsonlSessionFileOptions): Promise<OpenedJsonlSessionFile> {
    const sessionId = parseSessionId(options.sessionId);
    const dataDir = options.dataDir ?? resolveMissionControlDataDir(options);
    const sessionsDir = join(dataDir, 'sessions');
    const filePath = join(sessionsDir, `${sessionId}.jsonl`);
    const lockPath = join(sessionsDir, `${sessionId}.lock`);

    await mkdir(sessionsDir, { recursive: true });
    const lockHandle = await acquireSessionLock({ sessionId, lockPath, now: options.now });
    try {
        await ensureSessionLogFile({ sessionId, filePath, now: options.now });
        const contents = await readFile(filePath, 'utf8');
        const parsedLog = parseJsonlSessionLog({ contents, filePath, sessionId });
        const log = new SessionEventLog();
        for (const envelope of parsedLog.envelopes) {
            log.append(envelope.event);
        }
        const fileHandle = await open(filePath, 'a');
        return {
            sessionId,
            filePath,
            lockPath,
            fileHandle,
            lockHandle,
            log,
            nextSequence: nextSequenceAfter(parsedLog.envelopes),
        };
    } catch (error: unknown) {
        await releaseSessionLock(lockHandle, lockPath);
        throw error;
    }
}

export async function releaseSessionLock(lockHandle: FileHandle, lockPath: string): Promise<void> {
    try {
        await lockHandle.close();
    } finally {
        await rm(lockPath, { force: true });
    }
}

async function acquireSessionLock(input: {
    readonly sessionId: string;
    readonly lockPath: string;
    readonly now: () => string;
}): Promise<FileHandle> {
    let lockHandle: FileHandle;
    try {
        lockHandle = await open(input.lockPath, 'wx', 0o600);
    } catch (error: unknown) {
        if (getErrorCode(error) === 'EEXIST') {
            throw jsonlStoreError({
                code: 'lock_exists',
                message: `JSONL session log ${input.sessionId} is already locked`,
                sessionId: input.sessionId,
                path: input.lockPath,
                cause: error,
            });
        }
        throw jsonlStoreError({
            code: 'lock_failed',
            message: `JSONL session log ${input.sessionId} could not acquire its lock`,
            sessionId: input.sessionId,
            path: input.lockPath,
            cause: error,
        });
    }

    try {
        await lockHandle.writeFile(`${JSON.stringify({ sessionId: input.sessionId, createdAt: input.now() })}\n`);
        await lockHandle.sync();
        return lockHandle;
    } catch (error: unknown) {
        await releaseSessionLock(lockHandle, input.lockPath);
        throw jsonlStoreError({
            code: 'lock_failed',
            message: `JSONL session log ${input.sessionId} could not write its lock metadata`,
            sessionId: input.sessionId,
            path: input.lockPath,
            cause: error,
        });
    }
}

async function ensureSessionLogFile(input: {
    readonly sessionId: string;
    readonly filePath: string;
    readonly now: () => string;
}): Promise<void> {
    let headerHandle: FileHandle;
    try {
        headerHandle = await open(input.filePath, 'wx', 0o600);
    } catch (error: unknown) {
        if (getErrorCode(error) === 'EEXIST') {
            return;
        }
        throw jsonlStoreError({
            code: 'write_failed',
            message: `JSONL session log ${input.sessionId} could not create its file`,
            sessionId: input.sessionId,
            path: input.filePath,
            cause: error,
        });
    }

    try {
        await headerHandle.writeFile(
            serializeJsonlRecord(
                createJsonlSessionLogHeader({
                    sessionId: input.sessionId,
                    createdAt: input.now(),
                }),
            ),
            'utf8',
        );
        await headerHandle.sync();
    } finally {
        await headerHandle.close();
    }
}

function parseSessionId(sessionId: string): string {
    if (/^[A-Za-z0-9._-]+$/.test(sessionId)) {
        return sessionId;
    }
    throw new JsonlSessionEventStoreError({
        code: 'invalid_session_id',
        message: `Invalid JSONL session id ${sessionId}`,
        sessionId,
    });
}

function nextSequenceAfter(envelopes: readonly AgentEventEnvelope[]): number {
    const lastEnvelope = envelopes.at(-1);
    return lastEnvelope === undefined ? 0 : lastEnvelope.sequence + 1;
}

function getErrorCode(error: unknown): string | undefined {
    if (!(error instanceof Error) || !('code' in error)) {
        return undefined;
    }
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
}
