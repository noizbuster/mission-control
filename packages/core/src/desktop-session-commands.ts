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
import type { RunCoordinatorPromptInput, RunCoordinatorReadMessages } from './runtime/run-coordinator.js';
import { type SessionRunOwner, type SessionRunOwnerReceipt, SessionRunOwnerRegistry } from './runtime/run-owner.js';
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
    readonly status: 'blocked' | SessionRunOwnerReceipt['status'];
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
    private readonly runOwners: SessionRunOwnerRegistry;

    constructor(options: DesktopSessionCommandServiceOptions) {
        this.options = options;
        this.now = options.now ?? (() => new Date().toISOString());
        this.provider = options.provider ?? createDefaultDesktopProvider();
        this.runOwners = new SessionRunOwnerRegistry({
            ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
            provider: this.provider,
            modelProviderSelection: this.selection(),
            now: this.now,
            ...(options.createEventId !== undefined ? { createEventId: options.createEventId } : {}),
            resolveModelProviderSelection: async (store, sessionId, fallback) =>
                latestModelProviderSelection(await store.getEvents(sessionId)) ?? fallback,
        });
    }

    async submitPrompt(input: DesktopPromptCommandInput): Promise<DesktopCommandReceipt> {
        const selection = this.selection(input);
        return this.withOwner(input.sessionId, { modelProviderSelection: selection }, async (owner, store) => {
            await ensureSessionStarted(store, input.sessionId, selection, this.now);
            const result = await owner.submit(promptInput(input));
            await appendPendingToolApprovals({
                store,
                sessionId: input.sessionId,
                modelProviderSelection: selection,
                now: this.now,
            });
            return result.status;
        });
    }

    async queueFollowUp(input: DesktopPromptCommandInput): Promise<DesktopCommandReceipt> {
        const selection = this.selection(input);
        return this.withOwner(input.sessionId, { modelProviderSelection: selection }, async (owner, store) => {
            await ensureSessionStarted(store, input.sessionId, selection, this.now);
            return (await owner.queue(promptInput(input))).status;
        });
    }

    async steerRun(input: DesktopPromptCommandInput): Promise<DesktopCommandReceipt> {
        const selection = this.selection(input);
        return this.withOwner(input.sessionId, { modelProviderSelection: selection }, async (owner, store) => {
            await ensureSessionStarted(store, input.sessionId, selection, this.now);
            const result = await owner.steer(promptInput(input));
            await appendPendingToolApprovals({
                store,
                sessionId: input.sessionId,
                modelProviderSelection: selection,
                now: this.now,
            });
            return result.status;
        });
    }

    async resumeRun(input: DesktopRunCommandInput): Promise<DesktopCommandReceipt> {
        return this.withOwner(input.sessionId, {}, async (owner, store) => {
            await ensureSessionStarted(store, input.sessionId, owner.modelProviderSelection, this.now);
            const result = await owner.resume();
            await appendPendingToolApprovals({
                store,
                sessionId: input.sessionId,
                modelProviderSelection: owner.modelProviderSelection,
                now: this.now,
            });
            return result.status;
        });
    }

    async interruptRun(input: DesktopRunCommandInput): Promise<DesktopCommandReceipt> {
        return this.withOwner(input.sessionId, {}, async (owner, store) => {
            await ensureSessionStarted(store, input.sessionId, owner.modelProviderSelection, this.now);
            const result = await owner.interrupt(input.reason);
            return result.status;
        });
    }

    async decideApproval(input: DesktopApprovalDecisionInput): Promise<DesktopCommandReceipt> {
        let activeStore: JsonlSessionEventStore | undefined;
        return this.withOwner(
            input.sessionId,
            {
                readMessages: async () => {
                    if (activeStore === undefined) {
                        throw new TypeError('approval continuation requested before the session store was attached');
                    }
                    return projectDesktopApprovalContinuationMessages(
                        await activeStore.getEvents(input.sessionId),
                        input.sessionId,
                    );
                },
            },
            async (owner, store) => {
                activeStore = store;
                const selection = owner.modelProviderSelection;
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
                const result = await owner.resume();
                await appendPendingToolApprovals({
                    store,
                    sessionId: input.sessionId,
                    modelProviderSelection: selection,
                    now: this.now,
                });
                return result.status;
            },
        );
    }

    private selection(input?: { readonly modelProviderSelection?: ModelProviderSelection }): ModelProviderSelection {
        return input?.modelProviderSelection ?? this.options.modelProviderSelection ?? defaultModelProviderSelection;
    }

    private async withOwner(
        sessionId: string,
        options: {
            readonly modelProviderSelection?: ModelProviderSelection;
            readonly readMessages?: RunCoordinatorReadMessages;
        },
        action: (owner: SessionRunOwner, store: JsonlSessionEventStore) => Promise<DesktopCommandReceipt['status']>,
    ): Promise<DesktopCommandReceipt> {
        return this.runOwners.withOwner(
            {
                sessionId,
                ...(options.modelProviderSelection !== undefined
                    ? { modelProviderSelection: options.modelProviderSelection }
                    : {}),
                ...(options.readMessages !== undefined ? { readMessages: options.readMessages } : {}),
            },
            async (owner, store) => {
                const before = (await store.getEvents(sessionId)).length;
                const status = await action(owner, store);
                const after = (await store.getEvents(sessionId)).length;
                return { sessionId, status, eventsWritten: after - before };
            },
        );
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
