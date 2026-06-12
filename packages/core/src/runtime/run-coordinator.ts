import type {
    AgentEvent,
    AgentEventEnvelope,
    AgentMessage,
    RunCoordinatorCommand,
    RunCoordinatorEventMetadata,
    RunCoordinatorState,
} from '@mission-control/protocol';
import { projectSessionAdmission } from '../session-admission-projection.js';
import { SessionAdmissionService } from '../session-admission-service.js';
import * as runAdmission from './run-coordinator-admission.js';
import { RunCoordinatorIdSequence } from './run-coordinator-ids.js';
import {
    finalizeProviderTurnResult,
    type RunCoordinatorActiveRun,
    type RunCoordinatorProviderTurnResult,
    type RunCoordinatorResult,
    type RunCoordinatorRunEventType,
} from './run-coordinator-lifecycle.js';
import { promoteSingleRunInput, promoteWakeBatch } from './run-coordinator-promotion.js';
import { runCoordinatorProviderTurn } from './run-coordinator-provider-turn.js';
import {
    appendRunCoordinatorEnvelope,
    type RunCoordinatorPromptInput,
    type SessionRunCoordinatorOptions,
} from './run-coordinator-types.js';

export type { RunCoordinatorResult } from './run-coordinator-lifecycle.js';
export type {
    RunCoordinatorPromptInput,
    RunCoordinatorReadMessages,
    RunCoordinatorStore,
    SessionRunCoordinatorOptions,
} from './run-coordinator-types.js';

type DrainCommand = 'wake' | 'run' | 'resume';

export class SessionRunCoordinator {
    private readonly options: SessionRunCoordinatorOptions;
    private readonly admission: SessionAdmissionService;
    private readonly now: () => string;
    private readonly ids: RunCoordinatorIdSequence;
    private activeRun: RunCoordinatorActiveRun | undefined;
    private appendQueue: Promise<void> = Promise.resolve();

    constructor(options: SessionRunCoordinatorOptions) {
        this.options = options;
        this.now = options.now ?? (() => new Date().toISOString());
        this.ids = new RunCoordinatorIdSequence({
            sessionId: options.sessionId,
            store: options.store,
            createId: options.createId ?? ((prefix, index) => `${prefix}_${index}`),
        });
        this.admission = new SessionAdmissionService({
            sessionId: options.sessionId,
            store: options.store,
            now: this.now,
            appendEvent: (event) => this.appendDurableEvent(event),
        });
    }

    async steer(input: RunCoordinatorPromptInput): Promise<void> {
        await this.admit('steer', input);
    }

    async queue(input: RunCoordinatorPromptInput): Promise<void> {
        await this.admit('queue', input);
    }

    wake(): Promise<RunCoordinatorResult> {
        return this.startDrain('wake');
    }

    run(): Promise<RunCoordinatorResult> {
        return this.startDrain('run');
    }

    resume(): Promise<RunCoordinatorResult> {
        return this.startDrain('resume');
    }

    status(): RunCoordinatorResult {
        return this.activeRun === undefined
            ? { status: 'idle', turns: 0 }
            : { status: 'running', runId: this.activeRun.runId, turns: 0 };
    }

    async interrupt(reason = 'run interrupted'): Promise<RunCoordinatorResult> {
        const active = this.activeRun;
        const commandRecorded = this.appendRunEvent(
            'run.command.received',
            'interrupt',
            this.activeRun === undefined ? 'idle' : 'running',
            'run command: interrupt',
            {
                reason,
                ...(active?.runId !== undefined ? { runId: active.runId } : {}),
            },
        );
        active?.controller.abort();
        await commandRecorded;
        if (active === undefined) {
            return { status: 'idle', turns: 0 };
        }
        return active.settled;
    }

    private async admit(delivery: 'steer' | 'queue', input: RunCoordinatorPromptInput): Promise<void> {
        await this.ids.observe(input.inputId, input.messageId);
        const inputId = input.inputId ?? (await this.ids.next('input'));
        const messageId = input.messageId ?? (await this.ids.next('message'));
        const admittedInput = { ...input, inputId, messageId, delivery };
        await this.admission.assertCanAdmitPrompt(admittedInput);
        await this.appendRunEvent(
            'run.command.received',
            delivery,
            this.activeRun === undefined ? 'idle' : 'running',
            input.prompt,
            runAdmission.runMetadataForPromptInput(admittedInput),
        );
        await this.admission.admitPrompt(admittedInput);
    }

    private async startDrain(command: DrainCommand): Promise<RunCoordinatorResult> {
        if (this.activeRun !== undefined) {
            await this.appendRunEvent('run.command.received', command, 'running', `run command: ${command}`, {
                runId: this.activeRun.runId,
            });
            return this.activeRun.promise;
        }
        const runId = await this.ids.next('run');
        const controller = new AbortController();
        const promise = this.drain(command, runId, controller).finally(() => {
            this.activeRun = undefined;
        });
        this.activeRun = { runId, controller, promise, settled: promise };
        return promise;
    }

    private async drain(
        command: DrainCommand,
        runId: string,
        controller: AbortController,
    ): Promise<RunCoordinatorResult> {
        await this.appendRunEvent('run.command.received', command, 'idle', `run command: ${command}`, { runId });
        await this.appendRunEvent('run.started', command, 'running', 'run started', { runId });
        let turns = 0;
        let firstPromotion = true;

        while (!controller.signal.aborted) {
            const promotion =
                firstPromotion && command === 'wake'
                    ? await promoteWakeBatch(this.promotionInput())
                    : await promoteSingleRunInput(this.promotionInput());
            firstPromotion = false;
            if (promotion === 'idle' || (promotion === 'run_requested' && (turns > 0 || command === 'wake'))) {
                break;
            }
            const result = await this.runProviderTurn(controller.signal);
            turns += 1;
            const finalized = await finalizeProviderTurnResult({
                result,
                command,
                runId,
                turns,
                appendRunEvent: (...event) => this.appendRunEvent(...event),
            });
            if (finalized !== undefined) {
                return finalized;
            }
        }

        const status = turns === 0 ? 'idle' : 'completed';
        const eventType = status === 'idle' ? 'run.idle' : 'run.completed';
        await this.appendRunEvent(eventType, command, status, status === 'idle' ? 'run idle' : 'run completed', {
            runId,
        });
        return { status, runId, turns };
    }

    private async runProviderTurn(signal: AbortSignal): Promise<RunCoordinatorProviderTurnResult> {
        return runCoordinatorProviderTurn(
            {
                sessionId: this.options.sessionId,
                provider: this.options.provider,
                modelProviderSelection: this.options.modelProviderSelection,
                ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
                ...(this.options.retryLimit !== undefined ? { retryLimit: this.options.retryLimit } : {}),
                ...(this.options.toolCallLoopLimit !== undefined
                    ? { toolCallLoopLimit: this.options.toolCallLoopLimit }
                    : {}),
                ...(this.options.toolRegistry !== undefined ? { toolRegistry: this.options.toolRegistry } : {}),
                readMessages: () => this.modelVisibleMessages(),
                nextId: (prefix) => this.ids.next(prefix),
                appendDurableEvent: (event) => this.appendDurableEvent(event),
                appendDurableEnvelope: (envelope) => this.appendDurableEnvelope(envelope),
                ...(this.options.onProviderEnvelope !== undefined
                    ? { onProviderEnvelope: this.options.onProviderEnvelope }
                    : {}),
                ...(this.options.onToolCall !== undefined ? { onToolCall: this.options.onToolCall } : {}),
                ...(this.options.onToolSettlement !== undefined
                    ? { onToolSettlement: this.options.onToolSettlement }
                    : {}),
            },
            signal,
        );
    }

    private async modelVisibleMessages(): Promise<readonly AgentMessage[]> {
        if (this.options.readMessages !== undefined) {
            return this.options.readMessages();
        }
        const projection = projectSessionAdmission(
            await this.options.store.getEvents(this.options.sessionId),
            this.options.sessionId,
        );
        return projection.modelVisibleMessages.map((message) => ({ role: message.role, content: message.content }));
    }

    private async appendRunEvent(
        type: RunCoordinatorRunEventType,
        command: RunCoordinatorCommand,
        state: RunCoordinatorState,
        message: string,
        run: RunCoordinatorEventMetadata,
    ): Promise<void> {
        await this.appendDurableEvent({
            type,
            timestamp: this.now(),
            sessionId: this.options.sessionId,
            message,
            run: {
                command,
                state,
                ...run,
            },
        });
    }

    private promotionInput() {
        return {
            sessionId: this.options.sessionId,
            store: this.options.store,
            now: this.now,
            appendDurableEvent: (event: AgentEvent) => this.appendDurableEvent(event),
        };
    }

    private appendDurableEvent(event: AgentEvent): Promise<void> {
        const write = this.appendQueue.then(async () => {
            await this.options.store.append(event);
            await this.options.onDurableEvent?.(event);
        });
        this.appendQueue = write.catch(() => undefined);
        return write;
    }

    private appendDurableEnvelope(envelope: AgentEventEnvelope): Promise<void> {
        const write = this.appendQueue.then(async () => {
            await appendRunCoordinatorEnvelope(this.options.store, envelope);
            await this.options.onDurableEvent?.(envelope.event);
        });
        this.appendQueue = write.catch(() => undefined);
        return write;
    }
}
