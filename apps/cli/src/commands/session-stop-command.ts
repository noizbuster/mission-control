import {
    type SessionStopTreeResult,
    type StopLocalSessionTreeInput,
    stopLocalSessionTree,
} from '@mission-control/core';
import type { SessionStopScope } from '@mission-control/protocol';
import type { CliArgs } from '../args';
import type { CliCommandResult } from '../cli-command-result';
import { randomUUID } from 'node:crypto';

type SessionStopCommandInput = Pick<
    StopLocalSessionTreeInput,
    'targetSessionId' | 'scope' | 'requestId' | 'operationId' | 'timeoutMs'
>;

export type SessionStopCommandDependencies = {
    readonly executeStop?: (input: SessionStopCommandInput) => Promise<SessionStopTreeResult>;
    readonly monotonicNow?: () => number;
};

export async function runSessionStopCommand(
    args: CliArgs,
    dependencies: SessionStopCommandDependencies = {},
): Promise<CliCommandResult> {
    const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
    const startedAt = monotonicNow();
    try {
        const parsed = requireSessionStopInput(args);
        const remainingMs = Math.max(0, Math.floor(startedAt + parsed.timeoutMs - monotonicNow()));
        const result = await (dependencies.executeStop ?? stopLocalSessionTree)({
            targetSessionId: parsed.targetSessionId,
            scope: parsed.scope,
            requestId: randomUUID(),
            operationId: randomUUID(),
            timeoutMs: Math.min(parsed.timeoutMs, remainingMs),
        });
        return sessionStopCommandResult(result);
    } catch {
        return {
            stdout: 'Failed to stop sessions: internal_error.',
            stderr: '',
            exitCode: 1,
        };
    }
}

function requireSessionStopInput(args: CliArgs): {
    readonly targetSessionId: string;
    readonly scope: SessionStopScope;
    readonly timeoutMs: number;
} {
    if (
        args.command !== 'session-stop' ||
        args.sessionId === undefined ||
        args.sessionStopScope === undefined ||
        args.sessionStopTimeoutMs === undefined
    ) {
        throw new TypeError('missing parsed session stop input');
    }
    return {
        targetSessionId: args.sessionId,
        scope: args.sessionStopScope,
        timeoutMs: args.sessionStopTimeoutMs,
    };
}

function sessionStopCommandResult(result: SessionStopTreeResult): CliCommandResult {
    if (result.sessions.length === 0) {
        if (result.errorCode === 'session_not_found' || result.errorCode === 'unstable_session_tree') {
            return {
                stdout: `Failed to stop sessions: ${result.errorCode}.`,
                stderr: '',
                exitCode: 1,
            };
        }
        if (result.scope === 'children' && result.errorCode === undefined) {
            return { stdout: 'No sessions to stop.', stderr: '', exitCode: 0 };
        }
        if (result.errorCode !== undefined) {
            return { stdout: 'Stopped 0/1 session(s); 1 failed.', stderr: '', exitCode: 1 };
        }
    }

    const completed = result.sessions.filter(({ outcome }) => outcome === 'interrupted').length;
    const idle = result.sessions.filter(({ outcome }) => outcome === 'already_idle').length;
    const terminal = result.sessions.filter(({ outcome }) => outcome === 'already_terminal').length;
    const failed = result.sessions.filter(({ outcome }) => outcome === 'failed').length;
    const total = completed + idle + terminal + failed;
    if (failed > 0) {
        return {
            stdout: `Stopped ${completed}/${total} session(s); ${failed} failed.`,
            stderr: '',
            exitCode: 1,
        };
    }
    return {
        stdout: `Stopped ${completed}/${total} session(s) (${idle} already idle, ${terminal} already terminal).`,
        stderr: '',
        exitCode: 0,
    };
}
