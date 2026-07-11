import { describe, expect, it, vi } from 'vitest';
import { drainCoordinatorRun } from './run-coordinator-drain.js';

describe('drainCoordinatorRun interruption finalizer', () => {
    it('emits interrupted instead of idle when an operator abort wins before the first turn', async () => {
        const controller = new AbortController();
        controller.abort();
        const events: Array<{ readonly type: string; readonly run: Readonly<Record<string, unknown>> }> = [];

        const result = await drainCoordinatorRun({
            command: 'run',
            runId: 'run-aborted-before-turn',
            signal: controller.signal,
            promotionInput: vi.fn(),
            runProviderTurn: vi.fn(),
            appendRunEvent: async (type, _command, _state, _message, run) => {
                events.push({ type, run });
            },
            operatorStop: () => ({ requestId: 'request-stop', operationId: 'operation-stop' }),
            suppressInterruptedEvent: () => false,
        });

        expect(result).toMatchObject({ status: 'interrupted', runId: 'run-aborted-before-turn' });
        expect(events).toEqual([
            {
                type: 'run.command.received',
                run: { runId: 'run-aborted-before-turn' },
            },
            {
                type: 'run.started',
                run: { runId: 'run-aborted-before-turn' },
            },
            {
                type: 'run.interrupted',
                run: {
                    runId: 'run-aborted-before-turn',
                    requestId: 'request-stop',
                    operationId: 'operation-stop',
                    reason: 'operator_aborted',
                },
            },
        ]);
    });
});
