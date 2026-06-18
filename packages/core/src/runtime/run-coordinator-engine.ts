import type {
    AgentEvent,
    AgentEventEnvelope,
    RunCoordinatorCommand,
    RunCoordinatorEventMetadata,
    RunCoordinatorState,
} from '@mission-control/protocol';
import { SessionAdmissionService } from '../session-admission-service.js';
import { interruptActiveRun, statusFromActiveRun } from './run-coordinator-active-run.js';
import * as runAdmission from './run-coordinator-admission.js';
import {
    type BlockedRunSnapshot,
    type DrainCommand,
    drainCoordinatorRun,
    findResumableBlockedRun,
} from './run-coordinator-drain.js';
import { RunCoordinatorIdSequence } from './run-coordinator-ids.js';
import {
    type RunCoordinatorActiveRun,
    type RunCoordinatorProviderTurnResult,
    type RunCoordinatorResult,
    type RunCoordinatorRunEventType,
} from './run-coordinator-lifecycle.js';
import { readRunCoordinatorMessages } from './run-coordinator-messages.js';
import {
    appendRunCoordinatorEnvelope,
    type RunCoordinatorPromptInput,
    type RunCoordinatorTurnContext,
    type SessionRunCoordinatorOptions,
} from './run-coordinator-types.js';

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
        return statusFromActiveRun(this.activeRun);
    }

    async interrupt(reason = 'run interrupted'): Promise<RunCoordinatorResult> {
        return interruptActiveRun({
            activeRun: this.activeRun,
            appendRunEvent: (...event) => this.appendRunEvent(...event),
            reason,
        });
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
            this.activeRun?.kind === 'running' ? 'running' : (this.activeRun?.kind ?? 'idle'),
            input.prompt,
            runAdmission.runMetadataForPromptInput(admittedInput),
        );
        await this.admission.admitPrompt(admittedInput);
    }

    private async startDrain(command: DrainCommand): Promise<RunCoordinatorResult> {
        if (this.activeRun !== undefined) {
            if (this.activeRun.kind === 'running') {
                await this.appendRunEvent('run.command.received', command, 'running', `run command: ${command}`, {
                    runId: this.activeRun.runId,
                });
                return this.activeRun.promise;
            }
            if (command !== 'resume') {
                await this.appendRunEvent(
                    'run.command.received',
                    command,
                    'blocked_on_approval',
                    `run command: ${command}`,
                    { runId: this.activeRun.runId },
                );
                return this.activeRun.settled;
            }
            return this.startResumedDrain(command, this.activeRun.runId, {
                runId: this.activeRun.runId,
                ...(this.activeRun.reason !== undefined ? { reason: this.activeRun.reason } : {}),
                ...(this.activeRun.errorCode !== undefined ? { errorCode: this.activeRun.errorCode } : {}),
                ...(this.activeRun.toolCallId !== undefined ? { toolCallId: this.activeRun.toolCallId } : {}),
            });
        }
        if (command === 'resume') {
            const resumable = findResumableBlockedRun(await this.options.store.getEvents(this.options.sessionId));
            if (resumable !== undefined) {
                return this.startResumedDrain(command, resumable.runId, resumable);
            }
        }
        const runId = await this.ids.next('run');
        return this.startResumedDrain(command, runId);
    }

    private startResumedDrain(
        command: DrainCommand,
        runId: string,
        blocked?: BlockedRunSnapshot,
    ): Promise<RunCoordinatorResult> {
        const controller = new AbortController();
        const promise = this.drain(command, runId, controller, blocked);
        this.activeRun = { kind: 'running', runId, controller, promise, settled: promise };
        void promise.then(
            (result) => {
                if (this.activeRun?.kind !== 'running' || this.activeRun.promise !== promise) {
                    return;
                }
                if (result.status === 'blocked_on_approval') {
                    this.activeRun = {
                        kind: 'blocked_on_approval',
                        runId,
                        settled: Promise.resolve(result),
                        ...(result.reason !== undefined ? { reason: result.reason } : {}),
                        ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
                        ...(result.toolCallId !== undefined ? { toolCallId: result.toolCallId } : {}),
                    };
                    return;
                }
                this.activeRun = undefined;
            },
            () => {
                if (this.activeRun?.kind === 'running' && this.activeRun.promise === promise) {
                    this.activeRun = undefined;
                }
            },
        );
        return promise;
    }

    private async drain(
        command: DrainCommand,
        runId: string,
        controller: AbortController,
        blocked?: BlockedRunSnapshot,
    ): Promise<RunCoordinatorResult> {
        return drainCoordinatorRun({
            command,
            runId,
            signal: controller.signal,
            promotionInput: () => this.promotionInput(),
            runProviderTurn: (signal) => this.runProviderTurn(signal),
            appendRunEvent: (...event) => this.appendRunEvent(...event),
            ...(blocked !== undefined ? { blocked } : {}),
        });
    }

    private async runProviderTurn(signal: AbortSignal): Promise<RunCoordinatorProviderTurnResult> {
        const injected = this.options.runProviderTurn;
        if (injected === undefined) {
            throw new TypeError(
                `${this.options.sessionId}: SessionRunCoordinator requires runProviderTurn (the flat provider-turn loop has been removed). Inject a RunCoordinatorTurnRunner (e.g. createGraphTurnRunner) via SessionRunCoordinatorOptions or SessionRunOwnerRegistryOptions.createTurnRunner.`,
            );
        }
        return injected(this.turnContext(signal));
    }

    private turnContext(signal: AbortSignal): RunCoordinatorTurnContext {
        return { signal, ...this.turnContextFields() };
    }

    private turnContextFields(): Omit<RunCoordinatorTurnContext, 'signal'> {
        return {
            readMessages: () => this.modelVisibleMessages(),
            nextId: (prefix) => this.ids.next(prefix),
            appendDurableEvent: (event) => this.appendDurableEvent(event),
            appendDurableEnvelope: (envelope) => this.appendDurableEnvelope(envelope),
            ...(this.options.onProviderEnvelope !== undefined
                ? { onProviderEnvelope: this.options.onProviderEnvelope }
                : {}),
            ...(this.options.onToolCall !== undefined ? { onToolCall: this.options.onToolCall } : {}),
            ...(this.options.onToolSettlement !== undefined ? { onToolSettlement: this.options.onToolSettlement } : {}),
        };
    }

    private async modelVisibleMessages() {
        return readRunCoordinatorMessages(this.options);
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
