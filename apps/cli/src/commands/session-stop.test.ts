import type { SessionStopTreeResult } from '@mission-control/core';
import { describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { SESSION_STOP_USAGE, SessionCliUsageError } from '../session-args.js';
import { runSessionStopCommand } from './session-stop-command.js';

const TARGET_ID = 'session_stop_root';

describe('session stop arguments', () => {
    it.each([
        { argv: [], scope: 'tree', timeoutMs: 15_000 },
        { argv: ['--only'], scope: 'only', timeoutMs: 15_000 },
        { argv: ['--child-only'], scope: 'children', timeoutMs: 15_000 },
        { argv: ['--timeout', '100ms'], scope: 'tree', timeoutMs: 100 },
        { argv: ['--timeout', '15s', '--only'], scope: 'only', timeoutMs: 15_000 },
        { argv: ['--child-only', '--timeout', '5m'], scope: 'children', timeoutMs: 300_000 },
    ])('parses $argv with exact scope and timeout', ({ argv, scope, timeoutMs }) => {
        // Given
        const command = ['session', 'stop', TARGET_ID, ...argv];

        // When
        const result = parseArgs(command);

        // Then
        expect(result).toMatchObject({
            command: 'session-stop',
            sessionId: TARGET_ID,
            sessionStopScope: scope,
            sessionStopTimeoutMs: timeoutMs,
        });
    });

    it.each([
        ['--only', '--child-only'],
        ['--timeout'],
        ['--timeout', '0ms'],
        ['--timeout', '99ms'],
        ['--timeout', '300001ms'],
        ['--timeout', '6m'],
        ['--timeout', '15'],
        ['--timeout', '1.5s'],
        ['--timeout', '+1s'],
        ['--timeout', '-1s'],
        ['--timeout', ' 1s'],
        ['--timeout', '1S'],
        ['--timeout', '01s'],
        ['--timeout', '9007199254740991m'],
        ['--timeout', '1s', '--timeout', '2s'],
        ['--only', '--only'],
        ['--json'],
    ])('rejects invalid stop arguments %j as one usage error', (...argv) => {
        // Given
        const command = ['session', 'stop', TARGET_ID, ...argv];

        // When
        const parse = () => parseArgs(command);

        // Then
        expect(parse).toThrow(SessionCliUsageError);
        expect(parse).toThrow(SESSION_STOP_USAGE);
    });
});

describe('session stop command result', () => {
    it('formats a full result as one newline-free aggregate line', async () => {
        // Given
        const executeStop = vi.fn(async () =>
            treeResult([
                sessionResult('interrupted'),
                sessionResult('interrupted'),
                sessionResult('already_idle'),
                sessionResult('already_terminal'),
            ]),
        );

        // When
        const result = await runSessionStopCommand(stopArgs(), { executeStop });

        // Then
        expect(result).toEqual({
            stdout: 'Stopped 2/4 session(s) (1 already idle, 1 already terminal).',
            stderr: '',
            exitCode: 0,
        });
        expect(result.stdout).not.toContain('\n');
        expect(result.stdout).not.toContain(TARGET_ID);
        expect(result.stdout.startsWith('{')).toBe(false);
    });

    it('formats partial and established-target failures without per-session output', async () => {
        // Given
        const partial = treeResult([sessionResult('interrupted'), sessionResult('failed')], 'partial');
        const targetFailure = treeResult([], 'failed', 'owner_unreachable');

        // When
        const partialResult = await runSessionStopCommand(stopArgs(), {
            executeStop: async () => partial,
        });
        const targetResult = await runSessionStopCommand(stopArgs(), {
            executeStop: async () => targetFailure,
        });

        // Then
        expect(partialResult).toEqual({
            stdout: 'Stopped 1/2 session(s); 1 failed.',
            stderr: '',
            exitCode: 1,
        });
        expect(targetResult).toEqual({
            stdout: 'Stopped 0/1 session(s); 1 failed.',
            stderr: '',
            exitCode: 1,
        });
    });

    it.each([
        'session_not_found',
        'unstable_session_tree',
    ] as const)('maps a pre-stop %s failure to the exact public code', async (errorCode) => {
        // Given
        const executeStop = async () => treeResult([], 'failed', errorCode);

        // When
        const result = await runSessionStopCommand(stopArgs(), { executeStop });

        // Then
        expect(result).toEqual({
            stdout: `Failed to stop sessions: ${errorCode}.`,
            stderr: '',
            exitCode: 1,
        });
    });

    it('returns the child-only no-target summary', async () => {
        // Given
        const args = { ...stopArgs(), sessionStopScope: 'children' as const };

        // When
        const result = await runSessionStopCommand(args, {
            executeStop: async () => ({ ...treeResult([], 'no_op'), scope: 'children' }),
        });

        // Then
        expect(result).toEqual({ stdout: 'No sessions to stop.', stderr: '', exitCode: 0 });
    });

    it('maps unexpected failures to internal_error without exposing the thrown text', async () => {
        // Given
        const executeStop = async (): Promise<SessionStopTreeResult> => {
            throw new Error('secret endpoint and session_stop_child');
        };

        // When
        const result = await runSessionStopCommand(stopArgs(), { executeStop });

        // Then
        expect(result).toEqual({
            stdout: 'Failed to stop sessions: internal_error.',
            stderr: '',
            exitCode: 1,
        });
    });

    it('passes only the remaining overall deadline to Task 9', async () => {
        // Given
        const executeStop = vi.fn(async () => treeResult([], 'no_op'));
        const ticks = [100, 125];
        const monotonicNow = () => ticks.shift() ?? 125;

        // When
        await runSessionStopCommand({ ...stopArgs(), sessionStopTimeoutMs: 1_000 }, { executeStop, monotonicNow });

        // Then
        expect(executeStop).toHaveBeenCalledWith(
            expect.objectContaining({ targetSessionId: TARGET_ID, scope: 'tree', timeoutMs: 975 }),
        );
    });
});

function stopArgs() {
    return parseArgs(['session', 'stop', TARGET_ID]);
}

function treeResult(
    sessions: SessionStopTreeResult['sessions'],
    outcome: SessionStopTreeResult['outcome'] = 'full',
    errorCode?: SessionStopTreeResult['errorCode'],
): SessionStopTreeResult {
    return {
        outcome,
        targetSessionId: TARGET_ID,
        scope: 'tree',
        sessions,
        ...(errorCode !== undefined ? { errorCode } : {}),
    };
}

function sessionResult(outcome: 'interrupted' | 'already_idle' | 'already_terminal' | 'failed') {
    return {
        sessionId: `private-${outcome}`,
        depth: 1,
        outcome,
        requestId: 'private-request',
        operationId: 'private-operation',
        affected: {
            runs: 0,
            approvals: 0,
            sessionAwaits: 0,
            sessionInputs: 0,
            missionRuns: 0,
            asyncJobs: 0,
            toolCalls: 0,
        },
        ...(outcome === 'failed' ? { errorCode: 'stop_timeout' as const } : {}),
    };
}
