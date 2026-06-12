import { defaultModelProviderSelection } from '@mission-control/config';
import type { AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import {
    hasPendingDesktopApprovals,
    projectDesktopApprovalContinuationMessages,
} from './desktop-approval-transcript.js';
import {
    appendPendingToolApprovals,
    type DesktopApprovalDecisionInput,
    settleDesktopApproval,
} from './desktop-tool-approvals.js';
import { type JsonlSessionEventIdFactory, JsonlSessionEventStore } from './memory/jsonl-session-event-store.js';
import { createProviderAuthStoreCredentialResolver } from './providers/provider-auth-resolver.js';
import { createProviderAuthStore } from './providers/provider-auth-store.js';
import { createProviderRouter } from './providers/provider-factory.js';
import type { ProviderAdapter } from './providers/provider-turn-types.js';
import {
    type RunCoordinatorPromptInput,
    type RunCoordinatorReadMessages,
    type RunCoordinatorResult,
    SessionRunCoordinator,
} from './runtime/run-coordinator.js';
import type { CommandExecutionRequest, CommandExecutionResult } from './tools/command-run.js';

export type DesktopPromptCommandInput = {
    readonly sessionId: string;
    readonly prompt: string;
    readonly modelProviderSelection?: ModelProviderSelection;
    readonly parentMessageId?: string;
    readonly resume?: boolean;
};

export type DesktopRunCommandInput = {
    readonly sessionId: string;
    readonly reason?: string;
};

export type DesktopCommandReceipt = {
    readonly sessionId: string;
    readonly status: 'queued' | 'blocked' | RunCoordinatorResult['status'];
    readonly eventsWritten: number;
};

export type DesktopSessionCommandServiceOptions = {
    readonly dataDir?: string;
    readonly workspaceRoot: string;
    readonly provider?: ProviderAdapter;
    readonly modelProviderSelection?: ModelProviderSelection;
    readonly now?: () => string;
    readonly createEventId?: JsonlSessionEventIdFactory;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
};

export type DesktopSessionCommandService = {
    readonly submitPrompt: (input: DesktopPromptCommandInput) => Promise<DesktopCommandReceipt>;
    readonly queueFollowUp: (input: DesktopPromptCommandInput) => Promise<DesktopCommandReceipt>;
    readonly steerRun: (input: DesktopPromptCommandInput) => Promise<DesktopCommandReceipt>;
    readonly resumeRun: (input: DesktopRunCommandInput) => Promise<DesktopCommandReceipt>;
    readonly interruptRun: (input: DesktopRunCommandInput) => Promise<DesktopCommandReceipt>;
    readonly decideApproval: (input: DesktopApprovalDecisionInput) => Promise<DesktopCommandReceipt>;
};

export function createDesktopSessionCommandService(
    options: DesktopSessionCommandServiceOptions,
): DesktopSessionCommandService {
    return new DefaultDesktopSessionCommandService(options);
}

class DefaultDesktopSessionCommandService implements DesktopSessionCommandService {
    private readonly options: DesktopSessionCommandServiceOptions;
    private readonly now: () => string;
    private readonly provider: ProviderAdapter;

    constructor(options: DesktopSessionCommandServiceOptions) {
        this.options = options;
        this.now = options.now ?? (() => new Date().toISOString());
        this.provider = options.provider ?? createDefaultDesktopProvider();
    }

    async submitPrompt(input: DesktopPromptCommandInput): Promise<DesktopCommandReceipt> {
        return this.withStore(input.sessionId, async (store) => {
            await ensureSessionStarted(store, input.sessionId, this.selection(input), this.now);
            const coordinator = this.coordinator(store, input.sessionId, this.selection(input));
            await coordinator.steer(promptInput(input));
            const result = await coordinator.run();
            await appendPendingToolApprovals({
                store,
                sessionId: input.sessionId,
                modelProviderSelection: this.selection(input),
                now: this.now,
            });
            return result.status;
        });
    }

    async queueFollowUp(input: DesktopPromptCommandInput): Promise<DesktopCommandReceipt> {
        return this.withStore(input.sessionId, async (store) => {
            await ensureSessionStarted(store, input.sessionId, this.selection(input), this.now);
            await this.coordinator(store, input.sessionId, this.selection(input)).queue(promptInput(input));
            return 'queued';
        });
    }

    async steerRun(input: DesktopPromptCommandInput): Promise<DesktopCommandReceipt> {
        return this.withStore(input.sessionId, async (store) => {
            await ensureSessionStarted(store, input.sessionId, this.selection(input), this.now);
            const coordinator = this.coordinator(store, input.sessionId, this.selection(input));
            await coordinator.steer(promptInput(input));
            const result = await coordinator.wake();
            await appendPendingToolApprovals({
                store,
                sessionId: input.sessionId,
                modelProviderSelection: this.selection(input),
                now: this.now,
            });
            return result.status;
        });
    }

    async resumeRun(input: DesktopRunCommandInput): Promise<DesktopCommandReceipt> {
        return this.withStore(input.sessionId, async (store) => {
            const selection = await this.selectionForSession(store, input.sessionId);
            await ensureSessionStarted(store, input.sessionId, selection, this.now);
            const result = await this.coordinator(store, input.sessionId, selection).resume();
            await appendPendingToolApprovals({
                store,
                sessionId: input.sessionId,
                modelProviderSelection: selection,
                now: this.now,
            });
            return result.status;
        });
    }

    async interruptRun(input: DesktopRunCommandInput): Promise<DesktopCommandReceipt> {
        return this.withStore(input.sessionId, async (store) => {
            const selection = await this.selectionForSession(store, input.sessionId);
            await ensureSessionStarted(store, input.sessionId, selection, this.now);
            const result = await this.coordinator(store, input.sessionId, selection).interrupt(input.reason);
            return result.status;
        });
    }

    async decideApproval(input: DesktopApprovalDecisionInput): Promise<DesktopCommandReceipt> {
        return this.withStore(input.sessionId, async (store) => {
            const selection = await this.selectionForSession(store, input.sessionId);
            const status = await settleDesktopApproval(input, {
                store,
                sessionId: input.sessionId,
                workspaceRoot: this.options.workspaceRoot,
                modelProviderSelection: selection,
                now: this.now,
                ...(this.options.commandExecutor !== undefined
                    ? { commandExecutor: this.options.commandExecutor }
                    : {}),
            });
            if (status !== 'completed') {
                return status;
            }
            if (hasPendingDesktopApprovals(await store.getEvents(input.sessionId), input.sessionId)) {
                return status;
            }
            const result = await this.coordinator(store, input.sessionId, selection, {
                readMessages: async () =>
                    projectDesktopApprovalContinuationMessages(await store.getEvents(input.sessionId), input.sessionId),
            }).resume();
            await appendPendingToolApprovals({
                store,
                sessionId: input.sessionId,
                modelProviderSelection: selection,
                now: this.now,
            });
            return result.status;
        });
    }

    private coordinator(
        store: JsonlSessionEventStore,
        sessionId: string,
        modelProviderSelection: ModelProviderSelection,
        options: { readonly readMessages?: RunCoordinatorReadMessages } = {},
    ): SessionRunCoordinator {
        return new SessionRunCoordinator({
            sessionId,
            store,
            provider: this.provider,
            modelProviderSelection,
            now: this.now,
            ...(options.readMessages !== undefined ? { readMessages: options.readMessages } : {}),
        });
    }

    private selection(input?: { readonly modelProviderSelection?: ModelProviderSelection }): ModelProviderSelection {
        return input?.modelProviderSelection ?? this.options.modelProviderSelection ?? defaultModelProviderSelection;
    }

    private async selectionForSession(
        store: JsonlSessionEventStore,
        sessionId: string,
        input?: { readonly modelProviderSelection?: ModelProviderSelection },
    ): Promise<ModelProviderSelection> {
        if (input?.modelProviderSelection !== undefined) {
            return input.modelProviderSelection;
        }
        const events = await store.getEvents(sessionId);
        return latestModelProviderSelection(events) ?? this.selection();
    }

    private async withStore(
        sessionId: string,
        action: (store: JsonlSessionEventStore) => Promise<DesktopCommandReceipt['status']>,
    ): Promise<DesktopCommandReceipt> {
        const store = await JsonlSessionEventStore.open({
            sessionId,
            ...(this.options.dataDir !== undefined ? { dataDir: this.options.dataDir } : {}),
            now: this.now,
            ...(this.options.createEventId !== undefined ? { createEventId: this.options.createEventId } : {}),
        });
        try {
            const before = (await store.getEvents(sessionId)).length;
            const status = await action(store);
            const after = (await store.getEvents(sessionId)).length;
            return { sessionId, status, eventsWritten: after - before };
        } finally {
            await store.close();
        }
    }
}

async function ensureSessionStarted(
    store: JsonlSessionEventStore,
    sessionId: string,
    modelProviderSelection: ModelProviderSelection,
    now: () => string,
): Promise<void> {
    if ((await store.getEvents(sessionId)).length > 0) {
        return;
    }
    await store.append({
        type: 'session.started',
        timestamp: now(),
        sessionId,
        message: 'desktop session started',
        nativeSidecarStatus: 'mock',
        modelProviderSelection,
    });
}

function promptInput(input: DesktopPromptCommandInput): RunCoordinatorPromptInput {
    return {
        prompt: input.prompt,
        ...(input.parentMessageId !== undefined ? { parentMessageId: input.parentMessageId } : {}),
        ...(input.resume !== undefined ? { resume: input.resume } : {}),
    };
}

function latestModelProviderSelection(events: readonly AgentEvent[]): ModelProviderSelection | undefined {
    return [...events].reverse().find((event) => event.modelProviderSelection !== undefined)?.modelProviderSelection;
}

function createDefaultDesktopProvider(): ProviderAdapter {
    return createProviderRouter(createProviderAuthStoreCredentialResolver(createProviderAuthStore()));
}
