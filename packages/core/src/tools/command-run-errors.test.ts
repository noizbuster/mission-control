import { describe, expect, it } from 'vitest';
import { type CommandRunFailureCode, commandRunFailure } from './command-run-errors.js';

describe('commandRunFailure retryable mapping', () => {
    it('marks command_failed (nonzero exit) as retryable so a single failing command does not kill the run', () => {
        const error = commandRunFailure('command_failed', 'curl ... exit: 6');
        expect(error.error.retryable).toBe(true);
        expect(error.error.code).toBe('tool_failed');
        expect(error.error.message).toContain('command_failed');
    });

    it('marks command_spawn_failed, command_timed_out, and concurrency_limit as retryable', () => {
        const codes: CommandRunFailureCode[] = ['command_spawn_failed', 'command_timed_out', 'concurrency_limit'];
        for (const code of codes) {
            const error = commandRunFailure(code, 'detail');
            expect(error.error.retryable).toBe(true);
        }
    });

    it('marks approval_denied and approval_required as retryable (the settlement classifier handles them by prefix)', () => {
        const error = commandRunFailure('approval_denied', 'user denied');
        expect(error.error.retryable).toBe(true);
    });

    it('marks command_not_allowed as NON-retryable (hard policy block, model cannot fix by retrying)', () => {
        const error = commandRunFailure('command_not_allowed', 'not allowlisted');
        expect(error.error.retryable).toBe(false);
    });
});
