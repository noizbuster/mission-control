import type { AgentEvent } from '@mission-control/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
    createWorkflowRunOutcomeObserver,
    formatWorkflowTurnFooter,
} from './interactive-workflow-run-outcome';

const timestamp = '2026-07-13T00:00:00.000Z';

describe('interactive workflow Run outcome observer', () => {
    it('settles duplicate blocked observations exactly once', async () => {
        const settle = vi.fn(async () => undefined);
        const observer = createWorkflowRunOutcomeObserver({ settleOutcome: settle });
        const blocked = event('run.blocked', 'waiting for approval');

        observer.observe(blocked);
        observer.observe(blocked);
        await Promise.all([observer.settle(), observer.settle()]);

        expect(settle).toHaveBeenCalledTimes(1);
        expect(settle).toHaveBeenCalledWith({ status: 'blocked', reason: 'waiting for approval' });
    });

    it('allows a terminal owner event to replace the nonterminal blocked state', async () => {
        const settle = vi.fn(async () => undefined);
        const observer = createWorkflowRunOutcomeObserver({ settleOutcome: settle });

        observer.observe(event('run.blocked', 'waiting for approval'));
        observer.observe(event('run.completed', 'run completed'));
        await observer.settle();

        expect(settle).toHaveBeenCalledWith({ status: 'completed' });
    });

    it('gives a later durable interruption priority over an earlier task failure', async () => {
        const settle = vi.fn(async () => undefined);
        const observer = createWorkflowRunOutcomeObserver({ settleOutcome: settle });

        observer.observe(event('task.failed', 'provider turn interrupted'));
        observer.observe(event('run.interrupted', 'operator interrupted workflow'));
        await observer.settle();

        expect(settle).toHaveBeenCalledWith({ status: 'cancelled', reason: 'operator interrupted workflow' });
    });

    it('keeps typed interrupted task failure above a later owner failure when ordering reverses', async () => {
        const settle = vi.fn(async () => undefined);
        const observer = createWorkflowRunOutcomeObserver({ settleOutcome: settle });

        observer.observe({
            ...event('task.failed', 'provider turn interrupted'),
            run: { runId: 'run_interrupted', state: 'interrupted' },
        });
        observer.observe(event('run.failed', 'synthetic trailing failure'));
        await observer.settle();

        expect(settle).toHaveBeenCalledWith({ status: 'cancelled', reason: 'provider turn interrupted' });
    });

    it.each([
        { type: 'run.completed' as const, expected: { status: 'completed' } },
        { type: 'run.failed' as const, expected: { status: 'failed', reason: 'owner outcome' } },
        { type: 'task.completed' as const, expected: { status: 'completed' } },
        { type: 'task.failed' as const, expected: { status: 'failed', reason: 'owner outcome' } },
    ])('maps $type to its normal workflow outcome', async ({ type, expected }) => {
        const settle = vi.fn(async () => undefined);
        const observer = createWorkflowRunOutcomeObserver({ settleOutcome: settle });

        observer.observe(event(type, 'owner outcome'));
        await observer.settle();

        expect(settle).toHaveBeenCalledWith(expected);
    });

    it('ignores owner and task outcomes from another session or turn', async () => {
        const settle = vi.fn(async () => undefined);
        const observer = createWorkflowRunOutcomeObserver({
            expectedSessionId: 'session_expected',
            expectedTaskId: 'task_expected',
            requireOwnerRunIdentity: true,
            settleOutcome: settle,
        });

        observer.observe({
            ...event('run.started', 'other run'),
            sessionId: 'session_other',
            run: { runId: 'run_other' },
        });
        observer.observe({
            ...event('run.completed', 'other run'),
            sessionId: 'session_other',
            run: { runId: 'run_other' },
        });
        observer.observe({
            ...event('task.failed', 'other task'),
            sessionId: 'session_expected',
            taskId: 'task_other',
        });
        await observer.settle();

        expect(settle).not.toHaveBeenCalled();
    });

    it('binds durable terminal events to the owner run started in the expected session', async () => {
        const settle = vi.fn(async () => undefined);
        const observer = createWorkflowRunOutcomeObserver({
            expectedSessionId: 'session_expected',
            settleOutcome: settle,
        });

        observer.observe({
            ...event('run.started', 'run started'),
            sessionId: 'session_expected',
            run: { runId: 'run_expected' },
        });
        observer.observe({
            ...event('run.failed', 'wrong run'),
            sessionId: 'session_expected',
            run: { runId: 'run_other' },
        });
        observer.observe({
            ...event('run.completed', 'expected run'),
            sessionId: 'session_expected',
            run: { runId: 'run_expected' },
        });
        await observer.settle();

        expect(settle).toHaveBeenCalledWith({ status: 'completed' }, 'run_expected');
    });

    it('ignores a matching task outcome until the expected owner run starts', async () => {
        const settle = vi.fn(async () => undefined);
        const observer = createWorkflowRunOutcomeObserver({
            expectedSessionId: 'session_expected',
            expectedTaskId: 'task_expected',
            requireOwnerRunIdentity: true,
            settleOutcome: settle,
        });

        observer.observe({
            ...event('task.completed', 'unbound task'),
            sessionId: 'session_expected',
            taskId: 'task_expected',
        });
        await observer.settle();

        expect(settle).not.toHaveBeenCalled();
    });

    it('redacts credential-shaped terminal reasons before persistence', async () => {
        const settle = vi.fn(async () => undefined);
        const observer = createWorkflowRunOutcomeObserver({ settleOutcome: settle });

        observer.observe(event('task.failed', 'provider rejected sk-test-123456789012345678901234567890'));
        await observer.settle();

        expect(settle).toHaveBeenCalledWith({ status: 'failed', reason: expect.not.stringContaining('sk-test-') });
    });

    it('formats a turn footer with elapsed time and stop reason', () => {
        // Given / When / Then
        expect(formatWorkflowTurnFooter(1234, { status: 'completed' })).toBe(
            '\n---\nTurn elapsed: 1.23s · Stop reason: completed\n',
        );
        expect(formatWorkflowTurnFooter(15_000, { status: 'failed', reason: 'provider timeout' })).toBe(
            '\n---\nTurn elapsed: 15.0s · Stop reason: failed (provider timeout)\n',
        );
        expect(formatWorkflowTurnFooter(500, { status: 'blocked', reason: 'approval required' })).toContain(
            'Stop reason: blocked (approval required)',
        );
        expect(formatWorkflowTurnFooter(2500, { status: 'cancelled', reason: 'interrupted by user' })).toContain(
            'Stop reason: cancelled (interrupted by user)',
        );
    });
});

function event(type: AgentEvent['type'], message: string): AgentEvent {
    return { type, timestamp, message };
}
