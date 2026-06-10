import { projectJsonlSessionReplayPrefix, resolveMissionControlDataDir } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import type { CliArgs } from '../args.js';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type CliSessionCommandErrorCode = 'invalid_session_id' | 'session_not_found' | 'unsupported_session_command';

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

export async function runSessionCommand(args: CliArgs): Promise<string> {
    switch (args.command) {
        case 'session-list':
            return `${(await listSessionIds()).join('\n')}\n`;
        case 'session-show':
            return `${JSON.stringify(await showSession(requireSessionId(args)), null, 2)}\n`;
        case 'session-replay':
            return `${(await replaySession(requireSessionId(args))).map((event) => JSON.stringify(event)).join('\n')}\n`;
        default:
            throw new CliSessionCommandError({
                code: 'unsupported_session_command',
                message: `Unsupported session command: ${args.command}`,
            });
    }
}

async function listSessionIds(): Promise<readonly string[]> {
    const sessionsDir = sessionLogsDir();
    let entries: readonly string[];
    try {
        entries = await readdir(sessionsDir);
    } catch (error: unknown) {
        if (isMissingFileError(error)) {
            return [];
        }
        throw error;
    }
    return entries
        .filter((entry) => entry.endsWith('.jsonl'))
        .map((entry) => entry.slice(0, -'.jsonl'.length))
        .filter((sessionId) => parseSessionId(sessionId) !== undefined)
        .sort();
}

async function showSession(sessionId: string) {
    const projection = projectJsonlSessionReplayPrefix({
        sessionId,
        contents: await readSessionLog(sessionId),
    });
    return {
        sessionId,
        eventCount: projection.projection.events.length,
        snapshot: projection.projection.snapshot,
        graphSnapshots: projection.projection.graphSnapshots,
        approvals: projection.projection.approvals,
        toolOutcomes: projection.projection.toolOutcomes,
        diagnostics: projection.diagnostics,
    };
}

async function replaySession(sessionId: string): Promise<readonly AgentEvent[]> {
    return projectJsonlSessionReplayPrefix({
        sessionId,
        contents: await readSessionLog(sessionId),
    }).projection.events;
}

async function readSessionLog(sessionId: string): Promise<string> {
    const parsedSessionId = requireValidSessionId(sessionId);
    try {
        return await readFile(join(sessionLogsDir(), `${parsedSessionId}.jsonl`), 'utf8');
    } catch (error: unknown) {
        if (isMissingFileError(error)) {
            throw new CliSessionCommandError({
                code: 'session_not_found',
                message: `Session log not found: ${parsedSessionId}`,
                sessionId: parsedSessionId,
            });
        }
        throw error;
    }
}

function requireSessionId(args: CliArgs): string {
    if (args.sessionId === undefined) {
        throw new CliSessionCommandError({
            code: 'invalid_session_id',
            message: 'Session id is required',
        });
    }
    return requireValidSessionId(args.sessionId);
}

function requireValidSessionId(sessionId: string): string {
    const parsed = parseSessionId(sessionId);
    if (parsed === undefined) {
        throw new CliSessionCommandError({
            code: 'invalid_session_id',
            message: `Invalid session id: ${sessionId}`,
            sessionId,
        });
    }
    return parsed;
}

function parseSessionId(sessionId: string): string | undefined {
    return /^[A-Za-z0-9._-]+$/.test(sessionId) ? sessionId : undefined;
}

function sessionLogsDir(): string {
    return join(resolveMissionControlDataDir(), 'sessions');
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error && Reflect.get(error, 'code') === 'ENOENT';
}
