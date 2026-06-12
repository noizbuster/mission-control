import type { AgentEvent } from '@mission-control/protocol';
import type { PromptInputState, SessionAdmissionEventStore } from '../session-admission-types.js';
import * as runAdmission from './run-coordinator-admission.js';

export type RunCoordinatorPromotionResult = 'promoted' | 'idle' | 'run_requested';

export type RunCoordinatorPromotionInput = {
    readonly sessionId: string;
    readonly store: SessionAdmissionEventStore;
    readonly now: () => string;
    readonly appendDurableEvent: (event: AgentEvent) => Promise<void>;
};

export async function promoteWakeBatch(input: RunCoordinatorPromotionInput): Promise<RunCoordinatorPromotionResult> {
    const projection = await projectAdmission(input);
    if (projection.steeringInputs.length === 0) {
        return 'idle';
    }
    for (const prompt of projection.steeringInputs) {
        await promoteInput(input, prompt);
    }
    return 'promoted';
}

export async function promoteSingleRunInput(
    input: RunCoordinatorPromotionInput,
): Promise<RunCoordinatorPromotionResult> {
    const projection = await projectAdmission(input);
    const prompt = projection.steeringInputs.at(0) ?? projection.queuedInputs.at(0);
    if (prompt === undefined) {
        return 'run_requested';
    }
    await promoteInput(input, prompt);
    return 'promoted';
}

async function promoteInput(input: RunCoordinatorPromotionInput, prompt: PromptInputState): Promise<void> {
    await input.appendDurableEvent(runAdmission.promptPromotionEvent(prompt, input.sessionId, input.now()));
}

async function projectAdmission(
    input: RunCoordinatorPromotionInput,
): Promise<ReturnType<typeof runAdmission.projectRunCoordinatorAdmission>> {
    return runAdmission.projectRunCoordinatorAdmission(await input.store.getEvents(input.sessionId), input.sessionId);
}
