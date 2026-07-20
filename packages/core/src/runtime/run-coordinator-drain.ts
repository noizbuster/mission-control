import type {
    RunCoordinatorCommand,
    RunCoordinatorEventMetadata,
    RunCoordinatorState,
} from '@mission-control/protocol';
import { findResumableRun, type GraphResumeEvent } from './graph-resume-state';
import {
    finalizeProviderTurnResult,
    type RunCoordinatorProviderTurnResult,
    type RunCoordinatorResult,
    type RunCoordinatorRunEventType,
} from './run-coordinator-lifecycle';
import type { RunCoordinatorPromotionInput } from './run-coordinator-promotion';
import { promoteSingleRunInput, promoteWakeBatch } from './run-coordinator-promotion';

export type DrainCommand = 'wake' | 'run' | 'resume';

export type BlockedRunSnapshot = {
    readonly runId: string;
    readonly reason?: string;
    readonly errorCode?: RunCoordinatorResult['errorCode'];
    readonly toolCallId?: string;
};

export async function drainCoordinatorRun(input: {
    readonly command: DrainCommand;
    readonly runId: string;
    readonly blocked?: BlockedRunSnapshot;
    readonly signal: AbortSignal;
    readonly promotionInput: () => RunCoordinatorPromotionInput;
    /**
     * Invokes the turn runner for one promoted input. Must forward `command` (not only `signal`) so
     * resume-only checkpoint seeding survives the drain boundary.
     */
    readonly runProviderTurn: (signal: AbortSignal, command: DrainCommand) => Promise<RunCoordinatorProviderTurnResult>;
    readonly appendRunEvent: (
        type: RunCoordinatorRunEventType,
        command: RunCoordinatorCommand,
        state: RunCoordinatorState,
        message: string,
        run: RunCoordinatorEventMetadata,
    ) => Promise<void>;
    readonly operatorStop: () => { readonly requestId: string; readonly operationId: string } | undefined;
    readonly suppressInterruptedEvent: () => boolean;
}): Promise<RunCoordinatorResult> {
    await input.appendRunEvent(
        'run.command.received',
        input.command,
        input.blocked === undefined ? 'idle' : 'blocked_on_approval',
        `run command: ${input.command}`,
        {
            runId: input.runId,
            ...(input.blocked?.reason !== undefined ? { reason: input.blocked.reason } : {}),
            ...(input.blocked?.errorCode !== undefined ? { errorCode: input.blocked.errorCode } : {}),
            ...(input.blocked?.toolCallId !== undefined ? { toolCallId: input.blocked.toolCallId } : {}),
        },
    );
    await input.appendRunEvent('run.started', input.command, 'running', 'run started', { runId: input.runId });
    let turns = 0;
    let firstPromotion = true;

    while (!input.signal.aborted) {
        const promotion =
            firstPromotion && input.command === 'wake'
                ? await promoteWakeBatch(input.promotionInput())
                : await promoteSingleRunInput(input.promotionInput());
        firstPromotion = false;
        if (promotion === 'idle' || (promotion === 'run_requested' && (turns > 0 || input.command === 'wake'))) {
            break;
        }
        const result = await input.runProviderTurn(input.signal, input.command);
        turns += 1;
        const operatorStop = input.operatorStop();
        const finalized = await finalizeProviderTurnResult({
            result,
            command: input.command,
            runId: input.runId,
            turns,
            appendRunEvent: (...event) => input.appendRunEvent(...event),
            ...(operatorStop !== undefined ? { operatorStop } : {}),
            ...(input.suppressInterruptedEvent() ? { suppressInterruptedEvent: true } : {}),
        });
        if (finalized !== undefined) {
            return finalized;
        }
    }

    if (input.signal.aborted) {
        const operatorStop = input.operatorStop();
        const interrupted = await finalizeProviderTurnResult({
            result: { status: 'interrupted' },
            command: input.command,
            runId: input.runId,
            turns,
            appendRunEvent: (...event) => input.appendRunEvent(...event),
            ...(operatorStop !== undefined ? { operatorStop } : {}),
            ...(input.suppressInterruptedEvent() ? { suppressInterruptedEvent: true } : {}),
        });
        if (interrupted !== undefined) return interrupted;
    }

    const status = turns === 0 ? 'idle' : 'completed';
    await input.appendRunEvent(
        status === 'idle' ? 'run.idle' : 'run.completed',
        input.command,
        status,
        status === 'idle' ? 'run idle' : 'run completed',
        { runId: input.runId },
    );
    return { status, runId: input.runId, turns };
}

export function findResumableBlockedRun(events: readonly GraphResumeEvent[]): BlockedRunSnapshot | undefined {
    const resumable = findResumableRun(events);
    if (resumable?.kind !== 'approval') return undefined;
    return {
        runId: resumable.runId,
        ...(resumable.reason !== undefined ? { reason: resumable.reason } : {}),
        ...(resumable.errorCode !== undefined ? { errorCode: resumable.errorCode } : {}),
        ...(resumable.toolCallId !== undefined ? { toolCallId: resumable.toolCallId } : {}),
    };
}
