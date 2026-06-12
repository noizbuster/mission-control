import type { AgentEventEnvelope } from '@mission-control/protocol';
import { SessionEventLog } from '../session-log.js';
import { type DataDirResolutionOptions, resolveMissionControlDataDir } from './data-dir.js';
import { JsonlSessionEventStoreError, jsonlStoreError } from './jsonl-errors.js';
import {
    acquireJsonlSessionLock,
    type JsonlSessionLockLease,
    type JsonlSessionLockRecovery,
    releaseJsonlSessionLock,
} from './jsonl-session-lock.js';
import { createJsonlSessionLogHeader, parseJsonlSessionLog, serializeJsonlRecord } from './jsonl-session-records.js';
import { randomUUID } from 'node:crypto';
import { type FileHandle, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export type OpenJsonlSessionFileOptions = DataDirResolutionOptions & {
    readonly sessionId: string;
    readonly dataDir?: string;
    readonly now: () => string;
    readonly lockOwnerId?: string;
    readonly lockPid?: number;
    readonly lockStaleAfterMs?: number;
};

export type OpenedJsonlSessionFile = {
    readonly sessionId: string;
    readonly filePath: string;
    readonly lockPath: string;
    readonly fileHandle: FileHandle;
    readonly lockHandle: FileHandle;
    readonly lockLease: JsonlSessionLockLease;
    readonly lockRecovery?: JsonlSessionLockRecovery;
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
    const lock = await acquireJsonlSessionLock({
        sessionId,
        lockPath,
        now: options.now,
        ...(options.lockOwnerId !== undefined ? { ownerId: options.lockOwnerId } : {}),
        ...(options.lockPid !== undefined ? { pid: options.lockPid } : {}),
        ...(options.lockStaleAfterMs !== undefined ? { staleAfterMs: options.lockStaleAfterMs } : {}),
    });
    try {
        if (lock.lockRecovery !== undefined) {
            await fenceReclaimedSessionLog({ sessionId, filePath });
        }
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
            lockHandle: lock.lockHandle,
            lockLease: lock.lockLease,
            ...(lock.lockRecovery !== undefined ? { lockRecovery: lock.lockRecovery } : {}),
            log,
            nextSequence: nextSequenceAfter(parsedLog.envelopes),
        };
    } catch (error: unknown) {
        await releaseSessionLock(lock.lockHandle, lockPath);
        throw error;
    }
}

export async function releaseSessionLock(lockHandle: FileHandle, lockPath: string): Promise<void> {
    await releaseJsonlSessionLock(lockHandle, lockPath);
}

async function fenceReclaimedSessionLog(input: {
    readonly sessionId: string;
    readonly filePath: string;
}): Promise<void> {
    const contents = await readFenceableSessionLog(input);
    if (contents === undefined) {
        return;
    }

    const backupPath = `${input.filePath}.recovered-${randomUUID()}`;
    let renamed = false;
    let replacementVisible = false;
    try {
        await rename(input.filePath, backupPath);
        renamed = true;
        await writeDurableSessionLogCopy(input.filePath, contents);
        replacementVisible = true;
        await rm(backupPath, { force: true });
    } catch (error: unknown) {
        if (renamed && !replacementVisible) {
            await restoreFencedSessionLog({ backupPath, filePath: input.filePath });
        }
        throw writeFailed(input, 'could not fence the reclaimed session log', error);
    }
}

async function writeDurableSessionLogCopy(filePath: string, contents: string): Promise<void> {
    const handle = await open(filePath, 'wx', 0o600);
    try {
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function readFenceableSessionLog(input: {
    readonly sessionId: string;
    readonly filePath: string;
}): Promise<string | undefined> {
    try {
        return await readFile(input.filePath, 'utf8');
    } catch (error: unknown) {
        if (getErrorCode(error) !== 'ENOENT') {
            throw writeFailed(input, 'could not read the reclaimed session log before fencing', error);
        }
    }

    if (!(await restoreRecoveredSessionLogBackup(input.filePath))) {
        return undefined;
    }

    try {
        return await readFile(input.filePath, 'utf8');
    } catch (error: unknown) {
        throw writeFailed(input, 'could not read the restored session log before fencing', error);
    }
}

async function restoreRecoveredSessionLogBackup(filePath: string): Promise<boolean> {
    const directory = dirname(filePath);
    const prefix = `${basename(filePath)}.recovered-`;
    try {
        const entries = await readdir(directory, { encoding: 'utf8', withFileTypes: true });
        const backups = entries
            .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
            .map((entry) => entry.name)
            .sort();
        for (const backup of backups) {
            if (await restoreRecoveredBackupPath(join(directory, backup), filePath)) {
                return true;
            }
        }
    } catch (error: unknown) {
        if (getErrorCode(error) === 'ENOENT') {
            return false;
        }
        throw error;
    }
    return false;
}

async function restoreRecoveredBackupPath(backupPath: string, filePath: string): Promise<boolean> {
    try {
        await rename(backupPath, filePath);
        return true;
    } catch (error: unknown) {
        const code = getErrorCode(error);
        if (code === 'ENOENT') {
            return false;
        }
        if (code === 'EEXIST') {
            return false;
        }
        throw error;
    }
}

async function restoreFencedSessionLog(input: {
    readonly backupPath: string;
    readonly filePath: string;
}): Promise<void> {
    try {
        await rename(input.backupPath, input.filePath);
    } catch (error: unknown) {
        if (getErrorCode(error) !== 'ENOENT') {
            throw error;
        }
    }
}

async function ensureSessionLogFile(input: {
    readonly sessionId: string;
    readonly filePath: string;
    readonly now: () => string;
}): Promise<void> {
    if (await restoreRecoveredSessionLogBackup(input.filePath)) {
        return;
    }

    let headerHandle: FileHandle;
    try {
        headerHandle = await open(input.filePath, 'wx', 0o600);
    } catch (error: unknown) {
        if (getErrorCode(error) === 'EEXIST') {
            return;
        }
        throw writeFailed(input, 'could not create its file', error);
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

function writeFailed(input: { readonly sessionId: string; readonly filePath: string }, reason: string, cause: unknown) {
    return jsonlStoreError({
        code: 'write_failed',
        message: `JSONL session log ${input.sessionId} ${reason}`,
        sessionId: input.sessionId,
        path: input.filePath,
        cause,
    });
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
