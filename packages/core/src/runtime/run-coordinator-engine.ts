// allow: SIZE_OK -- HEAD 349 -> current 396 pure LOC; one queue, steer, resume, and interrupt drain-loop state machine.
import type { Client } from '@libsql/client';
import type {
    AgentEvent,
    AgentEventEnvelope,
    RunCoordinatorCommand,
    RunCoordinatorEventMetadata,
    RunCoordinatorState,
} from '@mission-control/protocol';
import { SessionAdmissionService } from '../session-admission-service';
import { findResumableRun } from './graph-resume-state';
import { interruptActiveRun, statusFromActiveRun } from './run-coordinator-active-run';
import * as runAdmission from './run-coordinator-admission';
import { type BlockedRunSnapshot, type DrainCommand, drainCoordinatorRun } from './run-coordinator-drain';
import { RunCoordinatorIdSequence } from './run-coordinator-ids';
import {
    type RunCoordinatorActiveRun,
    type RunCoordinatorProviderTurnResult,
    type RunCoordinatorResult,
    type RunCoordinatorRunEventType,
} from './run-coordinator-lifecycle';
import { readRunCoordinatorMessages } from './run-coordinator-messages';
import {
    appendRunCoordinatorEnvelope,
    type RunCoordinatorPromptInput,
    type RunCoordinatorTurnContext,
    type SessionRunCoordinatorOptions,
} from './run-coordinator-types';
import type { SessionControlAttachment, SessionControlStopContext } from './session-control-host';
import { appendFencedSessionStopEvent } from './session-stop-event-writer';

export class SessionRunCoordinator {
    private readonly options: SessionRunCoordinatorOptions;
    private readonly admission: SessionAdmissionService;
    private readonly now: () => string;
    private readonly ids: RunCoordinatorIdSequence;
    private activeRun: RunCoordinatorActiveRun | undefined;
    private appendQueue: Promise<void> = Promise.resolve();
    private readonly controlAttachments = new Map<string, Promise<SessionControlAttachment>>();
    private readonly operatorStops = new Map<string, { readonly requestId: string; readonly operationId: string }>();
    private readonly fencedRuns = new Set<string>();

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

    async close(): Promise<void> {
        const active = this.activeRun;
        if (active?.kind === 'running') active.controller.abort();
        await active?.settled.catch(() => undefined);
        await Promise.all([...this.controlAttachments.keys()].map((runId) => this.detachControl(runId)));
    }

    private async admit(delivery: 'steer' | 'queue', input: RunCoordinatorPromptInput): Promise<void> {
        await this.options.sessionControlHost?.acquire(this.options.sessionId);
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
            await this.detachControl(this.activeRun.runId);
            return this.startResumedDrain(command, this.activeRun.runId, {
                runId: this.activeRun.runId,
                ...(this.activeRun.reason !== undefined ? { reason: this.activeRun.reason } : {}),
                ...(this.activeRun.errorCode !== undefined ? { errorCode: this.activeRun.errorCode } : {}),
                ...(this.activeRun.toolCallId !== undefined ? { toolCallId: this.activeRun.toolCallId } : {}),
            });
        }
        if (command === 'resume') {
            const resumable = findResumableRun(await this.options.store.getEvents(this.options.sessionId));
            if (resumable !== undefined) {
                switch (resumable.kind) {
                    case 'approval':
                        return this.startResumedDrain(command, resumable.runId, {
                            runId: resumable.runId,
                            ...(resumable.reason !== undefined ? { reason: resumable.reason } : {}),
                            ...(resumable.errorCode !== undefined ? { errorCode: resumable.errorCode } : {}),
                            ...(resumable.toolCallId !== undefined ? { toolCallId: resumable.toolCallId } : {}),
                        });
                    case 'interrupted':
                        // Interrupted work is not approval-blocked; reuse runId without blocked metadata.
                        return this.startResumedDrain(command, resumable.runId);
                }
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
        const attachment = this.attachControl(runId, controller);
        const promise = this.drainAfterAttach(command, runId, controller, attachment, blocked);
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

    private async drainAfterAttach(
        command: DrainCommand,
        runId: string,
        controller: AbortController,
        attachment: Promise<SessionControlAttachment> | undefined,
        blocked?: BlockedRunSnapshot,
    ): Promise<RunCoordinatorResult> {
        await attachment;
        try {
            const result = await this.drain(command, runId, controller, blocked);
            if (result.status !== 'blocked_on_approval') await this.detachControl(runId);
            return result;
        } catch (error: unknown) {
            await this.detachControl(runId);
            throw error;
        }
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
            runProviderTurn: (signal, turnCommand) => this.runProviderTurn(signal, turnCommand),
            appendRunEvent: (...event) => this.appendRunEvent(...event),
            operatorStop: () => this.operatorStops.get(runId),
            suppressInterruptedEvent: () => this.fencedRuns.has(runId),
            ...(blocked !== undefined ? { blocked } : {}),
        });
    }

    private attachControl(runId: string, controller: AbortController): Promise<SessionControlAttachment> | undefined {
        const host = this.options.sessionControlHost;
        if (host === undefined) return undefined;
        const attachment = host.attachEntity({
            sessionId: this.options.sessionId,
            kind: 'run',
            entityId: runId,
            handles: [
                {
                    kind: 'provider',
                    handleId: `provider:${runId}`,
                    abort: (context) => this.stopAttachedRun(runId, controller, context),
                    writeSettlement: (client, context) => this.writeStopSettlement(client, runId, context),
                },
            ],
        });
        this.controlAttachments.set(runId, attachment);
        return attachment;
    }

    private async stopAttachedRun(
        runId: string,
        controller: AbortController,
        context: SessionControlStopContext,
    ): Promise<void> {
        if (context.kind === 'operator_stop') {
            this.operatorStops.set(runId, { requestId: context.requestId, operationId: context.operationId });
        }
        this.fencedRuns.add(runId);
        const active = this.activeRun;
        if (active?.runId === runId && active.kind === 'blocked_on_approval') {
            this.activeRun = undefined;
            await this.detachControl(runId);
            return;
        }
        controller.abort();
        await active?.settled;
    }

    private async writeStopSettlement(
        client: Client,
        runId: string,
        context: SessionControlStopContext,
    ): Promise<void> {
        if (context.kind !== 'operator_stop') return;
        await appendFencedSessionStopEvent({
            client,
            sessionId: this.options.sessionId,
            event: {
                type: 'run.interrupted',
                timestamp: context.timestamp,
                sessionId: this.options.sessionId,
                message: 'run interrupted',
                run: {
                    runId,
                    requestId: context.requestId,
                    operationId: context.operationId,
                    reason: 'operator_aborted',
                },
            },
            ...(this.options.observabilityRedactor !== undefined
                ? { observabilityRedactor: this.options.observabilityRedactor }
                : {}),
        });
    }

    private async detachControl(runId: string): Promise<void> {
        const attachment = this.controlAttachments.get(runId);
        this.controlAttachments.delete(runId);
        this.operatorStops.delete(runId);
        this.fencedRuns.delete(runId);
        await attachment?.then((value) => value.detach());
    }

    private async runProviderTurn(
        signal: AbortSignal,
        command: DrainCommand,
    ): Promise<RunCoordinatorProviderTurnResult> {
        const injected = this.options.runProviderTurn;
        if (injected === undefined) {
            throw new TypeError(
                `${this.options.sessionId}: SessionRunCoordinator requires runProviderTurn (the flat provider-turn loop has been removed). Inject a RunCoordinatorTurnRunner (e.g. createGraphTurnRunner) via SessionRunCoordinatorOptions or SessionRunOwnerRegistryOptions.createTurnRunner.`,
            );
        }
        return injected(this.turnContext(signal, command));
    }

    private turnContext(signal: AbortSignal, command: DrainCommand): RunCoordinatorTurnContext {
        return { signal, command, ...this.turnContextFields() };
    }

    private turnContextFields(): Omit<RunCoordinatorTurnContext, 'signal' | 'command'> {
        return {
            readMessages: () => this.modelVisibleMessages(),
            readSessionEvents: () => this.options.store.getEvents(this.options.sessionId),
            nextId: (prefix) => this.ids.next(prefix),
            appendDurableEvent: (event) => this.appendDurableEvent(event),
            appendDurableEvents: (events, signal) => this.appendDurableEvents(events, signal),
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

    /**
     * Batch-append durable events under one appendQueue slot. Prefer store.appendMany when present
     * (single write-lane transaction). Honor abort between items when falling back to one-by-one.
     */
    private appendDurableEvents(events: readonly AgentEvent[], signal?: AbortSignal): Promise<void> {
        if (events.length === 0) {
            return Promise.resolve();
        }
        const write = this.appendQueue.then(async () => {
            const store = this.options.store;
            if (store.appendMany !== undefined) {
                await store.appendMany(events, signal);
                if (this.options.onDurableEvent !== undefined) {
                    for (const event of events) {
                        if (signal?.aborted === true) {
                            break;
                        }
                        await this.options.onDurableEvent(event);
                    }
                }
                return;
            }
            for (const event of events) {
                if (signal?.aborted === true) {
                    break;
                }
                await store.append(event);
                await this.options.onDurableEvent?.(event);
            }
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
