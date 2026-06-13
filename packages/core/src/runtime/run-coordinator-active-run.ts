import type { RunCoordinatorCommand, RunCoordinatorState } from '@mission-control/protocol';
import type {
    RunCoordinatorActiveRun,
    RunCoordinatorResult,
    RunCoordinatorRunEventType,
} from './run-coordinator-lifecycle.js';

export function statusFromActiveRun(activeRun: RunCoordinatorActiveRun | undefined): RunCoordinatorResult {
    if (activeRun === undefined) {
        return { status: 'idle', turns: 0 };
    }
    if (activeRun.kind === 'running') {
        return { status: 'running', runId: activeRun.runId, turns: 0 };
    }
    return {
        status: 'blocked_on_approval',
        runId: activeRun.runId,
        turns: 0,
        ...(activeRun.reason !== undefined ? { reason: activeRun.reason } : {}),
        ...(activeRun.errorCode !== undefined ? { errorCode: activeRun.errorCode } : {}),
        ...(activeRun.toolCallId !== undefined ? { toolCallId: activeRun.toolCallId } : {}),
    };
}

export async function interruptActiveRun(input: {
    readonly activeRun: RunCoordinatorActiveRun | undefined;
    readonly appendRunEvent: (
        type: RunCoordinatorRunEventType,
        command: RunCoordinatorCommand,
        state: RunCoordinatorState,
        message: string,
        run: {
            readonly runId?: string;
            readonly reason?: string;
        },
    ) => Promise<void>;
    readonly reason: string;
}): Promise<RunCoordinatorResult> {
    const active = input.activeRun;
    const commandRecorded = input.appendRunEvent(
        'run.command.received',
        'interrupt',
        input.activeRun?.kind === 'running' ? 'running' : (input.activeRun?.kind ?? 'idle'),
        'run command: interrupt',
        {
            reason: input.reason,
            ...(active?.runId !== undefined ? { runId: active.runId } : {}),
        },
    );
    if (active?.kind === 'running') {
        active.controller.abort();
    }
    await commandRecorded;
    return active?.settled ?? { status: 'idle', turns: 0 };
}
