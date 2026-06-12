import type { ModelProviderSelection } from '@mission-control/protocol';
import { type JsonlSessionEventIdFactory, JsonlSessionEventStore } from '../memory/jsonl-session-event-store.js';
import type { ProviderAdapter } from '../providers/provider-turn-types.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { type RunCoordinatorResult, SessionRunCoordinator } from './run-coordinator.js';
import type {
    RunCoordinatorEnvelopeObserver,
    RunCoordinatorEventObserver,
    RunCoordinatorPromptInput,
    RunCoordinatorReadMessages,
    RunCoordinatorToolCallObserver,
    RunCoordinatorToolSettlementObserver,
} from './run-coordinator-types.js';
import { promptInput } from './run-owner-prompt-input.js';

export type SessionRunOwnerReceipt = {
    readonly sessionId: string;
    readonly status: 'queued' | RunCoordinatorResult['status'];
    readonly runId?: string;
    readonly turns: number;
    readonly reason?: string;
    readonly errorCode?: RunCoordinatorResult['errorCode'];
    readonly toolCallId?: string;
};

type RunOwnerObserverOptions = {
    readonly onDurableEvent?: RunCoordinatorEventObserver;
    readonly onProviderEnvelope?: RunCoordinatorEnvelopeObserver;
    readonly onToolCall?: RunCoordinatorToolCallObserver;
    readonly onToolSettlement?: RunCoordinatorToolSettlementObserver;
};

export type SessionRunOwnerOptions = {
    readonly sessionId: string;
    readonly store: JsonlSessionEventStore;
    readonly provider: ProviderAdapter;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly now?: () => string;
    readonly timeoutMs?: number;
    readonly retryLimit?: number;
    readonly toolCallLoopLimit?: number;
    readonly toolRegistry?: ToolRegistry;
    readonly createId?: (prefix: string, index: number) => string;
    readonly readMessages?: RunCoordinatorReadMessages;
} & RunOwnerObserverOptions;

export type SessionRunOwnerRegistryOptions = {
    readonly dataDir?: string;
    readonly provider: ProviderAdapter;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly resolveModelProviderSelection?: (
        store: JsonlSessionEventStore,
        sessionId: string,
        fallback: ModelProviderSelection,
    ) => Promise<ModelProviderSelection>;
    readonly now?: () => string;
    readonly timeoutMs?: number;
    readonly retryLimit?: number;
    readonly toolCallLoopLimit?: number;
    readonly toolRegistry?: ToolRegistry;
    readonly lockStaleAfterMs?: number;
    readonly lockHeartbeatIntervalMs?: number;
    readonly createEventId?: JsonlSessionEventIdFactory;
    readonly createId?: (prefix: string, index: number) => string;
} & RunOwnerObserverOptions;

export type SessionRunOwnerLeaseInput = {
    readonly sessionId: string;
    readonly modelProviderSelection?: ModelProviderSelection;
    readonly readMessages?: RunCoordinatorReadMessages;
};

type OwnerEntry = {
    readonly owner: SessionRunOwner;
    readonly store: JsonlSessionEventStore;
    refCount: number;
};

type OwnerEntryRecord = {
    readonly promise: Promise<OwnerEntry>;
};

// Session-scoped facade over one `SessionRunCoordinator` and one JSONL store lease.
// The owner is process-local; durable recovery comes from the JSONL session log.
export class SessionRunOwner {
    readonly sessionId: string;
    readonly store: JsonlSessionEventStore;
    readonly modelProviderSelection: ModelProviderSelection;
    private readonly coordinator: SessionRunCoordinator;

    constructor(options: SessionRunOwnerOptions) {
        this.sessionId = options.sessionId;
        this.store = options.store;
        this.modelProviderSelection = options.modelProviderSelection;
        this.coordinator = new SessionRunCoordinator({
            sessionId: options.sessionId,
            store: options.store,
            provider: options.provider,
            modelProviderSelection: options.modelProviderSelection,
            ...(options.now !== undefined ? { now: options.now } : {}),
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            ...(options.retryLimit !== undefined ? { retryLimit: options.retryLimit } : {}),
            ...(options.toolCallLoopLimit !== undefined ? { toolCallLoopLimit: options.toolCallLoopLimit } : {}),
            ...(options.toolRegistry !== undefined ? { toolRegistry: options.toolRegistry } : {}),
            ...(options.createId !== undefined ? { createId: options.createId } : {}),
            ...(options.readMessages !== undefined ? { readMessages: options.readMessages } : {}),
            ...(options.onDurableEvent !== undefined ? { onDurableEvent: options.onDurableEvent } : {}),
            ...(options.onProviderEnvelope !== undefined ? { onProviderEnvelope: options.onProviderEnvelope } : {}),
            ...(options.onToolCall !== undefined ? { onToolCall: options.onToolCall } : {}),
            ...(options.onToolSettlement !== undefined ? { onToolSettlement: options.onToolSettlement } : {}),
        });
    }

    async submit(input: RunCoordinatorPromptInput): Promise<SessionRunOwnerReceipt> {
        await this.coordinator.steer(input);
        return this.receipt(await this.coordinator.run());
    }

    async queue(input: RunCoordinatorPromptInput): Promise<SessionRunOwnerReceipt> {
        await this.coordinator.queue(input);
        return { sessionId: this.sessionId, status: 'queued', turns: 0 };
    }

    async steer(input: RunCoordinatorPromptInput): Promise<SessionRunOwnerReceipt> {
        await this.coordinator.steer(input);
        return this.receipt(await this.coordinator.wake());
    }

    async resume(): Promise<SessionRunOwnerReceipt> {
        return this.receipt(await this.coordinator.resume());
    }

    async interrupt(reason?: string): Promise<SessionRunOwnerReceipt> {
        return this.receipt(await this.coordinator.interrupt(reason));
    }

    status(): SessionRunOwnerReceipt {
        return this.receipt(this.coordinator.status());
    }

    close(): Promise<void> {
        return this.store.close();
    }

    private receipt(result: RunCoordinatorResult): SessionRunOwnerReceipt {
        return {
            sessionId: this.sessionId,
            status: result.status,
            ...(result.runId !== undefined ? { runId: result.runId } : {}),
            turns: result.turns,
            ...(result.reason !== undefined ? { reason: result.reason } : {}),
            ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
            ...(result.toolCallId !== undefined ? { toolCallId: result.toolCallId } : {}),
        };
    }
}

// Durable run-owner registry contract:
// Ownership: at most one open owner per `sessionId` in this process.
// Concurrency: concurrent attaches share the owner and are reference-counted.
// Recovery: fresh attaches reopen JSONL and seed coordinator state from events.
// Process restart: a new registry resumes queued/blocked work from JSONL.
export class SessionRunOwnerRegistry {
    private readonly options: SessionRunOwnerRegistryOptions;
    private readonly entries = new Map<string, OwnerEntryRecord>();

    constructor(options: SessionRunOwnerRegistryOptions) {
        this.options = options;
    }

    submit(input: SessionRunOwnerLeaseInput & RunCoordinatorPromptInput): Promise<SessionRunOwnerReceipt> {
        return this.withOwner(input, (owner) => owner.submit(promptInput(input)));
    }

    queue(input: SessionRunOwnerLeaseInput & RunCoordinatorPromptInput): Promise<SessionRunOwnerReceipt> {
        return this.withOwner(input, (owner) => owner.queue(promptInput(input)));
    }

    steer(input: SessionRunOwnerLeaseInput & RunCoordinatorPromptInput): Promise<SessionRunOwnerReceipt> {
        return this.withOwner(input, (owner) => owner.steer(promptInput(input)));
    }

    resume(input: SessionRunOwnerLeaseInput): Promise<SessionRunOwnerReceipt> {
        return this.withOwner(input, (owner) => owner.resume());
    }

    interrupt(input: SessionRunOwnerLeaseInput & { readonly reason?: string }): Promise<SessionRunOwnerReceipt> {
        return this.withOwner(input, (owner) => owner.interrupt(input.reason));
    }

    status(input: SessionRunOwnerLeaseInput): Promise<SessionRunOwnerReceipt> {
        return this.withOwner(input, (owner) => owner.status());
    }

    async withOwner<Result>(
        input: SessionRunOwnerLeaseInput,
        action: (owner: SessionRunOwner, store: JsonlSessionEventStore) => Promise<Result> | Result,
    ): Promise<Result> {
        const record = this.entryRecord(input);
        let entry: OwnerEntry;
        try {
            entry = await record.promise;
        } catch (error) {
            if (this.entries.get(input.sessionId) === record) {
                this.entries.delete(input.sessionId);
            }
            throw error;
        }
        entry.refCount += 1;
        try {
            return await action(entry.owner, entry.store);
        } finally {
            entry.refCount -= 1;
            await this.release(input.sessionId, record, entry);
        }
    }

    private entryRecord(input: SessionRunOwnerLeaseInput): OwnerEntryRecord {
        const existing = this.entries.get(input.sessionId);
        if (existing !== undefined) {
            return existing;
        }
        const record: OwnerEntryRecord = { promise: this.createEntry(input) };
        this.entries.set(input.sessionId, record);
        return record;
    }

    private async createEntry(input: SessionRunOwnerLeaseInput): Promise<OwnerEntry> {
        const store = await JsonlSessionEventStore.open({
            sessionId: input.sessionId,
            ...(this.options.dataDir !== undefined ? { dataDir: this.options.dataDir } : {}),
            ...(this.options.now !== undefined ? { now: this.options.now } : {}),
            ...(this.options.createEventId !== undefined ? { createEventId: this.options.createEventId } : {}),
            ...(this.options.lockStaleAfterMs !== undefined ? { lockStaleAfterMs: this.options.lockStaleAfterMs } : {}),
            ...(this.options.lockHeartbeatIntervalMs !== undefined
                ? { lockHeartbeatIntervalMs: this.options.lockHeartbeatIntervalMs }
                : {}),
        });
        const modelProviderSelection =
            input.modelProviderSelection ??
            (await this.options.resolveModelProviderSelection?.(
                store,
                input.sessionId,
                this.options.modelProviderSelection,
            )) ??
            this.options.modelProviderSelection;
        const owner = new SessionRunOwner({
            sessionId: input.sessionId,
            store,
            provider: this.options.provider,
            modelProviderSelection,
            ...(this.options.now !== undefined ? { now: this.options.now } : {}),
            ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
            ...(this.options.retryLimit !== undefined ? { retryLimit: this.options.retryLimit } : {}),
            ...(this.options.toolCallLoopLimit !== undefined
                ? { toolCallLoopLimit: this.options.toolCallLoopLimit }
                : {}),
            ...(this.options.toolRegistry !== undefined ? { toolRegistry: this.options.toolRegistry } : {}),
            ...(this.options.createId !== undefined ? { createId: this.options.createId } : {}),
            ...(input.readMessages !== undefined ? { readMessages: input.readMessages } : {}),
            ...(this.options.onDurableEvent !== undefined ? { onDurableEvent: this.options.onDurableEvent } : {}),
            ...(this.options.onProviderEnvelope !== undefined
                ? { onProviderEnvelope: this.options.onProviderEnvelope }
                : {}),
            ...(this.options.onToolCall !== undefined ? { onToolCall: this.options.onToolCall } : {}),
            ...(this.options.onToolSettlement !== undefined ? { onToolSettlement: this.options.onToolSettlement } : {}),
        });
        return { owner, store, refCount: 0 };
    }

    private async release(sessionId: string, record: OwnerEntryRecord, entry: OwnerEntry): Promise<void> {
        if (entry.refCount > 0 || entry.owner.status().status === 'running') {
            return;
        }
        if (this.entries.get(sessionId) === record) {
            this.entries.delete(sessionId);
        }
        await entry.owner.close();
    }
}
