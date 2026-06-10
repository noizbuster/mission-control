import { defaultModelProviderSelection } from '@mission-control/config';
import type { ModelProviderSelection } from '@mission-control/protocol';
import {
    appendPendingToolApprovals,
    type DesktopApprovalDecisionInput,
    settleDesktopApproval,
} from './desktop-tool-approvals.js';
import { type JsonlSessionEventIdFactory, JsonlSessionEventStore } from './memory/jsonl-session-event-store.js';
import { createDeterministicProvider } from './providers/deterministic-provider.js';
import type { ProviderAdapter } from './providers/provider-turn-types.js';
import { type RunCoordinatorPromptInput, SessionRunCoordinator } from './runtime/run-coordinator.js';
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
    readonly status: 'queued' | 'idle' | 'running' | 'completed' | 'interrupted' | 'blocked' | 'failed';
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

    constructor(options: DesktopSessionCommandServiceOptions) {
        this.options = options;
        this.now = options.now ?? (() => new Date().toISOString());
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
            const selection = this.selection();
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
            const selection = this.selection();
            await ensureSessionStarted(store, input.sessionId, selection, this.now);
            const result = await this.coordinator(store, input.sessionId, selection).interrupt(input.reason);
            return result.status;
        });
    }

    async decideApproval(input: DesktopApprovalDecisionInput): Promise<DesktopCommandReceipt> {
        return this.withStore(input.sessionId, async (store) =>
            settleDesktopApproval(input, {
                store,
                sessionId: input.sessionId,
                workspaceRoot: this.options.workspaceRoot,
                modelProviderSelection: this.selection(),
                now: this.now,
                ...(this.options.commandExecutor !== undefined
                    ? { commandExecutor: this.options.commandExecutor }
                    : {}),
            }),
        );
    }

    private coordinator(
        store: JsonlSessionEventStore,
        sessionId: string,
        modelProviderSelection: ModelProviderSelection,
    ): SessionRunCoordinator {
        return new SessionRunCoordinator({
            sessionId,
            store,
            provider: this.options.provider ?? echoProvider(),
            modelProviderSelection,
            now: this.now,
        });
    }

    private selection(input?: { readonly modelProviderSelection?: ModelProviderSelection }): ModelProviderSelection {
        return input?.modelProviderSelection ?? this.options.modelProviderSelection ?? defaultModelProviderSelection;
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

function echoProvider(): ProviderAdapter {
    return createDeterministicProvider([{ kind: 'response_completed', content: 'desktop prompt received' }]);
}
