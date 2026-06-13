import type {
    AgentEvent,
    RunCoordinatorCommand,
    RunCoordinatorEventMetadata,
    RunCoordinatorState,
} from '@mission-control/protocol';
import {
    finalizeProviderTurnResult,
    type RunCoordinatorProviderTurnResult,
    type RunCoordinatorResult,
    type RunCoordinatorRunEventType,
} from './run-coordinator-lifecycle.js';
import type { RunCoordinatorPromotionInput } from './run-coordinator-promotion.js';
import { promoteSingleRunInput, promoteWakeBatch } from './run-coordinator-promotion.js';

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
    readonly runProviderTurn: (signal: AbortSignal) => Promise<RunCoordinatorProviderTurnResult>;
    readonly appendRunEvent: (
        type: RunCoordinatorRunEventType,
        command: RunCoordinatorCommand,
        state: RunCoordinatorState,
        message: string,
        run: RunCoordinatorEventMetadata,
    ) => Promise<void>;
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
        const result = await input.runProviderTurn(input.signal);
        turns += 1;
        const finalized = await finalizeProviderTurnResult({
            result,
            command: input.command,
            runId: input.runId,
            turns,
            appendRunEvent: (...event) => input.appendRunEvent(...event),
        });
        if (finalized !== undefined) {
            return finalized;
        }
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

export function findResumableBlockedRun(events: readonly AgentEvent[]): BlockedRunSnapshot | undefined {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event === undefined || event.run?.runId === undefined) {
            continue;
        }
        if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.interrupted') {
            return undefined;
        }
        if (event.type !== 'run.blocked' || event.run.state !== 'blocked_on_approval') {
            continue;
        }
        return {
            runId: event.run.runId,
            ...(event.run.reason !== undefined ? { reason: event.run.reason } : {}),
            ...(event.run.errorCode !== undefined ? { errorCode: event.run.errorCode } : {}),
            ...(event.run.toolCallId !== undefined ? { toolCallId: event.run.toolCallId } : {}),
        };
    }
    return undefined;
}
