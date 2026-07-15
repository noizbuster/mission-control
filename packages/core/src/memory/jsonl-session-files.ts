import type { AgentEventEnvelope } from '@mission-control/protocol';
import { SessionEventLog } from '../session-log';
import { type DataDirResolutionOptions, resolveMissionControlDataDir } from './data-dir';
import { JsonlSessionEventStoreError, jsonlStoreError } from './jsonl-errors';
import { createJsonlSessionLogHeader, parseJsonlSessionLog, serializeJsonlRecord } from './jsonl-session-records';
import { type FileHandle, mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type OpenJsonlSessionFileOptions = DataDirResolutionOptions & {
    readonly sessionId: string;
    readonly dataDir?: string;
    readonly now: () => string;
};

export type OpenedJsonlSessionFile = {
    readonly sessionId: string;
    readonly filePath: string;
    readonly fileHandle: FileHandle;
    readonly log: SessionEventLog;
    readonly nextSequence: number;
};

export async function openJsonlSessionFile(options: OpenJsonlSessionFileOptions): Promise<OpenedJsonlSessionFile> {
    const sessionId = parseSessionId(options.sessionId);
    const dataDir = options.dataDir ?? resolveMissionControlDataDir(options);
    const sessionsDir = join(dataDir, 'sessions');
    const filePath = join(sessionsDir, `${sessionId}.jsonl`);

    await mkdir(sessionsDir, { recursive: true });
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
        fileHandle,
        log,
        nextSequence: nextSequenceAfter(parsedLog.envelopes),
    };
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
