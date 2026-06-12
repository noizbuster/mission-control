import type { AgentEvent } from '@mission-control/protocol';
import { projectSessionAdmission } from './session-admission-projection.js';
import type {
    AdmitPromptInput,
    PromptAdmissionReceipt,
    PromptInputState,
    PromptPromotionResult,
    PromptPromotionTrigger,
    SessionAdmissionEventStore,
} from './session-admission-types.js';

export type SessionAdmissionServiceOptions = {
    readonly sessionId: string;
    readonly store: SessionAdmissionEventStore;
    readonly now?: () => string;
    readonly appendEvent?: (event: AgentEvent) => Promise<void>;
};

export class SessionAdmissionError extends Error {
    readonly code: 'empty_prompt' | 'input_conflict';

    constructor(code: 'empty_prompt' | 'input_conflict', message: string) {
        super(message);
        this.name = 'SessionAdmissionError';
        this.code = code;
    }
}

export class SessionAdmissionService {
    private readonly sessionId: string;
    private readonly store: SessionAdmissionEventStore;
    private readonly now: () => string;
    private readonly appendEvent: (event: AgentEvent) => Promise<void>;

    constructor(options: SessionAdmissionServiceOptions) {
        this.sessionId = options.sessionId;
        this.store = options.store;
        this.now = options.now ?? (() => new Date().toISOString());
        this.appendEvent = options.appendEvent ?? ((event) => this.store.append(event));
    }

    async assertCanAdmitPrompt(input: AdmitPromptInput): Promise<void> {
        validateAdmitPromptInput(input);
        const existing = await this.findExistingAdmission(input.inputId);
        if (existing !== undefined) {
            assertExistingAdmissionCanRetry(existing, input);
        }
    }

    async admitPrompt(input: AdmitPromptInput): Promise<PromptAdmissionReceipt> {
        await this.assertCanAdmitPrompt(input);
        const existing = await this.findExistingAdmission(input.inputId);
        if (existing !== undefined) {
            return exactRetryReceipt(existing.input, input);
        }

        await this.appendEvent({
            type: 'prompt.admitted',
            timestamp: this.now(),
            sessionId: this.sessionId,
            message: input.prompt,
            transcript: transcriptForInput(input, 'pending'),
        });

        return {
            inputId: input.inputId,
            messageId: input.messageId,
            delivery: input.delivery,
            scheduledWake: input.resume !== false,
        };
    }

    private async findExistingAdmission(inputId: string): Promise<ExistingAdmission | undefined> {
        const projection = projectSessionAdmission(await this.store.getEvents(this.sessionId), this.sessionId);
        const input = projection.admittedInputs.find((admitted) => admitted.inputId === inputId);
        if (input === undefined) {
            return undefined;
        }
        return {
            input,
            stillPending: projection.pendingInputs.some((pending) => pending.inputId === inputId),
        };
    }

    async requestWake(): Promise<PromptPromotionResult> {
        const projection = projectSessionAdmission(await this.store.getEvents(this.sessionId), this.sessionId);
        const nextSteer = projection.steeringInputs.at(0);
        if (nextSteer === undefined) {
            return { kind: 'idle' };
        }
        return this.promoteInput(nextSteer, 'wake');
    }

    async requestWakeBatch(): Promise<readonly PromptPromotionResult[]> {
        const projection = projectSessionAdmission(await this.store.getEvents(this.sessionId), this.sessionId);
        if (projection.steeringInputs.length === 0) {
            return [{ kind: 'idle' }];
        }
        const results: PromptPromotionResult[] = [];
        for (const input of projection.steeringInputs) {
            results.push(await this.promoteInput(input, 'wake'));
        }
        return results;
    }

    async requestRun(): Promise<PromptPromotionResult> {
        const projection = projectSessionAdmission(await this.store.getEvents(this.sessionId), this.sessionId);
        const nextInput = projection.steeringInputs.at(0) ?? projection.queuedInputs.at(0);
        if (nextInput === undefined) {
            return { kind: 'run_requested' };
        }
        return this.promoteInput(nextInput, 'run');
    }

    private async promoteInput(
        input: PromptInputState,
        trigger: PromptPromotionTrigger,
    ): Promise<PromptPromotionResult> {
        await this.appendEvent({
            type: 'prompt.promoted',
            timestamp: this.now(),
            sessionId: this.sessionId,
            message: input.prompt,
            transcript: {
                inputId: input.inputId,
                messageId: input.messageId,
                delivery: input.delivery,
                visibility: 'model_visible',
                ...(input.parentMessageId !== undefined ? { parentMessageId: input.parentMessageId } : {}),
                ...(input.providerTurnId !== undefined ? { providerTurnId: input.providerTurnId } : {}),
                ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
                ...(input.graphId !== undefined ? { graphId: input.graphId } : {}),
                ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
            },
        });
        return {
            kind: 'promoted',
            trigger,
            inputId: input.inputId,
            messageId: input.messageId,
        };
    }
}

type ExistingAdmission = {
    readonly input: PromptInputState;
    readonly stillPending: boolean;
};

function transcriptForInput(input: AdmitPromptInput, visibility: 'pending'): AgentEvent['transcript'] {
    return {
        inputId: input.inputId,
        messageId: input.messageId,
        delivery: input.delivery,
        visibility,
        ...(input.parentMessageId !== undefined ? { parentMessageId: input.parentMessageId } : {}),
        ...(input.providerTurnId !== undefined ? { providerTurnId: input.providerTurnId } : {}),
        ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
        ...(input.graphId !== undefined ? { graphId: input.graphId } : {}),
        ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    };
}

function validateAdmitPromptInput(input: AdmitPromptInput): void {
    if (input.prompt.length === 0) {
        throw new SessionAdmissionError('empty_prompt', 'prompt admission requires non-empty prompt text');
    }
}

function assertExistingAdmissionCanRetry(existing: ExistingAdmission, input: AdmitPromptInput): void {
    if (!existing.stillPending) {
        throw new SessionAdmissionError('input_conflict', `prompt input id ${input.inputId} has already been promoted`);
    }
    exactRetryReceipt(existing.input, input);
}

function exactRetryReceipt(existing: PromptInputState, input: AdmitPromptInput): PromptAdmissionReceipt {
    if (
        existing.prompt !== input.prompt ||
        existing.messageId !== input.messageId ||
        existing.delivery !== input.delivery ||
        existing.parentMessageId !== input.parentMessageId ||
        existing.providerTurnId !== input.providerTurnId ||
        existing.toolCallId !== input.toolCallId ||
        existing.graphId !== input.graphId ||
        existing.nodeId !== input.nodeId
    ) {
        throw new SessionAdmissionError(
            'input_conflict',
            `prompt input id ${input.inputId} already belongs to another admission`,
        );
    }
    return {
        inputId: existing.inputId,
        messageId: existing.messageId,
        delivery: existing.delivery,
        scheduledWake: input.resume !== false,
    };
}
