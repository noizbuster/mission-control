import {
    deleteLocalSessionTreeRows,
    LocalSessionTreeDeleteError,
    resolveMissionControlDataDir,
} from '@mission-control/core';
import { CliSessionCommandError } from './session-command-error';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

export async function deleteSessionTree(input: {
    readonly sessionId: string;
    readonly expectedTreeToken?: string;
}): Promise<string> {
    let deleted: Awaited<ReturnType<typeof deleteLocalSessionTreeRows>>;
    try {
        deleted = await deleteLocalSessionTreeRows({
            targetSessionId: input.sessionId,
            ...(input.expectedTreeToken !== undefined ? { expectedTreeToken: input.expectedTreeToken } : {}),
        });
    } catch (error: unknown) {
        if (error instanceof LocalSessionTreeDeleteError) throw cliDeleteError(error.code, input.sessionId);
        throw error;
    }
    await Promise.all(deleted.map(({ sessionId }) => rm(sessionLogPath(sessionId), { force: true })));
    return deleted.map(({ sessionId, eventCount }) => `Deleted session ${sessionId} (${eventCount} events)`).join('\n');
}

function sessionLogsDir(): string {
    return join(resolveMissionControlDataDir(), 'sessions');
}

function sessionLogPath(sessionId: string): string {
    return join(sessionLogsDir(), `${sessionId}.jsonl`);
}

function cliDeleteError(code: LocalSessionTreeDeleteError['code'], sessionId: string): CliSessionCommandError {
    switch (code) {
        case 'session_not_found':
            return new CliSessionCommandError({ code, message: `Session not found: ${sessionId}`, sessionId });
        case 'unstable_session_tree':
            return new CliSessionCommandError({ code, message: `Unstable session tree: ${sessionId}`, sessionId });
        case 'session_tree_changed':
            return new CliSessionCommandError({ code, message: `Session tree changed: ${sessionId}`, sessionId });
        case 'session_live_locked':
            return new CliSessionCommandError({ code, message: `Session is live locked: ${sessionId}`, sessionId });
        default:
            return unreachableDeleteError(code);
    }
}

function unreachableDeleteError(code: never): never {
    throw new TypeError(`unsupported session delete error: ${String(code)}`);
}
