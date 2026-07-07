import {
    createSessionArchive,
    JSONL_SESSION_EVENT_RECORD_KIND,
    JSONL_SESSION_LOG_HEADER_KIND,
    JSONL_SESSION_LOG_RECORD_VERSION,
    ProjectTrustStore,
    parseJsonlSessionLog,
    parseSessionArchive,
    readLocalSessionReplay,
    resolveMissionControlDataDir,
    validateSessionArchiveManifestForImport,
} from '@mission-control/core';
import type { AgentEventEnvelope } from '@mission-control/protocol';
import { deriveSessionCatalogProjection } from './session-catalog-projection.js';
import { parseCliSessionId } from './session-id.js';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export class SessionArchiveCommandError extends Error {
    readonly code:
        | 'archive_exists'
        | 'invalid_session_id'
        | 'missing_cwd'
        | 'missing_trust'
        | 'session_exists'
        | 'session_not_found'
        | 'untrusted_workspace';

    constructor(input: { readonly code: SessionArchiveCommandError['code']; readonly message: string }) {
        super(input.message);
        this.name = 'SessionArchiveCommandError';
        this.code = input.code;
    }
}

export async function exportSessionArchiveFile(input: {
    readonly sessionId: string;
    readonly filePath: string;
}): Promise<string> {
    const sessionId = requireValidSessionId(input.sessionId);
    const source = await readArchiveSource(sessionId);
    const projection = deriveSessionCatalogProjection({ sessionId, contents: source.contents });
    const workspace = await workspaceForArchive(projection);
    const archive = createSessionArchive({
        sessionId,
        cwd: workspace.cwd,
        trustedRoot: workspace.trustedRoot,
        createdAt: projection.createdAt ?? new Date().toISOString(),
        eventsJsonl: source.contents,
    });
    await mkdir(dirname(input.filePath), { recursive: true });
    try {
        await writeFile(input.filePath, `${JSON.stringify(archive, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch (error: unknown) {
        if (isExistingFileError(error)) {
            throw new SessionArchiveCommandError({
                code: 'archive_exists',
                message: `Archive path already exists: ${input.filePath}`,
            });
        }
        throw error;
    }
    return `Exported session ${sessionId} to ${input.filePath}\n`;
}

async function readArchiveSource(sessionId: string): Promise<{ readonly contents: string }> {
    const sessionPath = resolveSessionLogPath(sessionId);
    try {
        const contents = await readFile(sessionPath, 'utf8');
        parseJsonlSessionLog({ contents, filePath: sessionPath, sessionId });
        return { contents };
    } catch (error: unknown) {
        if (!isMissingFileError(error)) {
            throw error;
        }
    }
    const replay = await readLocalSessionReplay({ sessionId });
    if (replay.kind === 'missing') {
        throw new SessionArchiveCommandError({
            code: 'session_not_found',
            message: `Session log not found: ${sessionId}`,
        });
    }
    return { contents: serializeReplayAsJsonl(sessionId, replay.replay.projection.envelopes) };
}

function serializeReplayAsJsonl(sessionId: string, envelopes: readonly AgentEventEnvelope[]): string {
    const createdAt = envelopes.at(0)?.createdAt ?? new Date().toISOString();
    return [
        serializeJsonlRecord({
            kind: JSONL_SESSION_LOG_HEADER_KIND,
            version: JSONL_SESSION_LOG_RECORD_VERSION,
            sessionId,
            createdAt,
        }),
        ...envelopes.map((envelope) =>
            serializeJsonlRecord({
                kind: JSONL_SESSION_EVENT_RECORD_KIND,
                version: JSONL_SESSION_LOG_RECORD_VERSION,
                event: envelope,
            }),
        ),
    ].join('');
}

function serializeJsonlRecord(record: unknown): string {
    return `${JSON.stringify(record)}\n`;
}

export async function importSessionArchiveFile(input: { readonly filePath: string }): Promise<string> {
    const archive = parseSessionArchive(await readFile(input.filePath, 'utf8'));
    const trust = await new ProjectTrustStore().getDecision(process.cwd());
    if (trust.decision !== 'trusted') {
        throw new SessionArchiveCommandError({
            code: 'untrusted_workspace',
            message: `Session import requires a trusted workspace: ${trust.workspaceRoot}`,
        });
    }
    validateSessionArchiveManifestForImport({
        manifest: archive.manifest,
        expectedSessionId: archive.manifest.sessionId,
        expectedCwd: trust.workspaceRoot,
        trustedRoot: trust.workspaceRoot,
    });
    const sessionId = requireValidSessionId(archive.manifest.sessionId);
    const sessionPath = resolveSessionLogPath(sessionId);
    parseJsonlSessionLog({
        contents: archive.eventsJsonl,
        filePath: sessionPath,
        sessionId,
    });
    await mkdir(dirname(sessionPath), { recursive: true });
    let wroteSessionPath = false;
    try {
        await writeFile(sessionPath, archive.eventsJsonl, { encoding: 'utf8', flag: 'wx' });
        wroteSessionPath = true;
        const replay = await readLocalSessionReplay({ sessionId });
        if (replay.kind === 'missing') {
            throw new SessionArchiveCommandError({
                code: 'session_not_found',
                message: `Imported session could not be projected: ${sessionId}`,
            });
        }
    } catch (error: unknown) {
        if (wroteSessionPath) {
            await rm(sessionPath, { force: true });
        }
        if (isExistingFileError(error)) {
            throw new SessionArchiveCommandError({
                code: 'session_exists',
                message: `Session already exists: ${sessionId}`,
            });
        }
        throw error;
    }
    return `Imported session ${sessionId} from ${input.filePath}\n`;
}

async function workspaceForArchive(
    projection: ReturnType<typeof deriveSessionCatalogProjection>,
): Promise<{ readonly cwd: string; readonly trustedRoot: string }> {
    const cwd = projection.cwd;
    const trustedRoot = projection.trustedRoot;
    if (cwd !== undefined && trustedRoot !== undefined) {
        return { cwd, trustedRoot };
    }
    const trust = await new ProjectTrustStore().getDecision(process.cwd());
    if (trust.decision !== 'trusted') {
        throw new SessionArchiveCommandError({
            code: 'missing_trust',
            message: 'Session export requires workspace metadata or a trusted current workspace',
        });
    }
    return { cwd: trust.workspaceRoot, trustedRoot: trust.workspaceRoot };
}

function sessionLogsDir(): string {
    return join(resolveMissionControlDataDir(), 'sessions');
}

function requireValidSessionId(sessionId: string): string {
    const parsed = parseCliSessionId(sessionId);
    if (parsed === undefined) {
        throw new SessionArchiveCommandError({
            code: 'invalid_session_id',
            message: `Invalid session id: ${sessionId}`,
        });
    }
    return parsed;
}

function resolveSessionLogPath(sessionId: string): string {
    const sessionsDir = resolve(sessionLogsDir());
    const sessionPath = resolve(sessionsDir, `${sessionId}.jsonl`);
    const relativePath = relative(sessionsDir, sessionPath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        throw new SessionArchiveCommandError({
            code: 'invalid_session_id',
            message: `Invalid session id: ${sessionId}`,
        });
    }
    return sessionPath;
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error && Reflect.get(error, 'code') === 'ENOENT';
}

function isExistingFileError(error: unknown): boolean {
    return error instanceof Error && Reflect.get(error, 'code') === 'EEXIST';
}
