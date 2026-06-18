import { defaultModelProviderSelection } from '@mission-control/config';
import type {
    AbgNodeModelOptions,
    AgentEvent,
    AgentMessage,
    ModelProviderSelection,
    PermissionDecision,
    PermissionRequest,
} from '@mission-control/protocol';
import {
    hasPendingDesktopApprovals,
    projectDesktopApprovalContinuationMessages,
} from './desktop-approval-transcript.js';
import {
    type DesktopApprovalDecisionInput,
    ensurePendingToolApprovalForCurrentBlockedRun,
    ensureRuntimeOwnedPermissionRequestForBlockedToolCall,
    settleDesktopApproval,
} from './desktop-tool-approvals.js';
import { type JsonlSessionEventIdFactory, JsonlSessionEventStore } from './memory/jsonl-session-event-store.js';
import { createProviderAuthStoreCredentialResolver } from './providers/provider-auth-resolver.js';
import { createProviderAuthStore } from './providers/provider-auth-store.js';
import { createProviderRouter } from './providers/provider-factory.js';
import type { ProviderAdapter } from './providers/provider-turn-types.js';
import type { RunCoordinatorPromptInput, RunCoordinatorReadMessages } from './runtime/run-coordinator.js';
import { type SessionRunOwner, type SessionRunOwnerReceipt, SessionRunOwnerRegistry } from './runtime/run-owner.js';
import type { RunCoordinatorTurnRunner } from './runtime/run-coordinator-types.js';
import { createGraphTurnRunner } from './runtime/graph-coordinator-turn.js';
import { createCodingAgentGraph } from './behavior/coding-agent-graph.js';
import { createCodingAgentNodeRegistry } from './behavior/coding-agent-registry.js';
import { wrapFlatProviderAsSdkModel } from './providers/ai-sdk/flat-provider-bridge.js';
import type { CommandExecutionRequest, CommandExecutionResult } from './tools/command-run.js';
import { registerCommandRunTool } from './tools/command-run.js';
import { registerFileEditTool } from './tools/file-edit.js';
import { registerFilePatchTool } from './tools/file-patch.js';
import { registerFileWriteTool } from './tools/file-write.js';
import { ToolRegistry } from './tools/tool-registry.js';

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
    private graphToolRegistryPromise: Promise<ToolRegistry> | undefined;

    constructor(options: DesktopSessionCommandServiceOptions) {
        this.options = options;
        this.now = options.now ?? (() => new Date().toISOString());
        this.provider = options.provider ?? createDefaultDesktopProvider();
        this.runOwners = new SessionRunOwnerRegistry({
            ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
            provider: this.provider,
            modelProviderSelection: this.selection(),
            now: this.now,
            // Drive every owner on the ABG graph (the desktop's engine); a denied/non-allowlisted tool
            // terminates the run instead of looping (parity with the CLI graph owner path).
            haltOnFailedToolSettlement: true,
            createTurnRunner: (deps) => this.createGraphTurnRunner(deps),
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
            await backfillCurrentBlockedDesktopApproval(store, input.sessionId, selection, this.now, result);
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
            await backfillCurrentBlockedDesktopApproval(store, input.sessionId, selection, this.now, result);
            return result.status;
        });
    }

    async resumeRun(input: DesktopRunCommandInput): Promise<DesktopCommandReceipt> {
        return this.withOwner(input.sessionId, {}, async (owner, store) => {
            await ensureSessionStarted(store, input.sessionId, owner.modelProviderSelection, this.now);
            const result = await owner.resume();
            await backfillCurrentBlockedDesktopApproval(
                store,
                input.sessionId,
                owner.modelProviderSelection,
                this.now,
                result,
            );
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
                const events = await store.getEvents(input.sessionId);
                if (hasPendingDesktopApprovals(events, input.sessionId)) {
                    return status;
                }
                const continuationMessages = projectDesktopApprovalContinuationMessages(events, input.sessionId);
                if (!hasSettledToolContinuation(continuationMessages)) {
                    return status;
                }
                const result = await owner.resume();
                await backfillCurrentBlockedDesktopApproval(store, input.sessionId, selection, this.now, result);
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

    /**
     * Build the ABG graph turn runner for one owner. Bridges the flat `ProviderAdapter` to an AI-SDK
     * model (so the desktop's provider runs on the graph) and drives the default coding-agent graph
     * over the desktop's blocking tool surface. Every tool call settles `approval_required` → the
     * graph blocks → the desktop's event-layer approval flow (`decideApproval`/`settleDesktopApproval`)
     * executes the approved tool out-of-band and resumes. This is parity with the flat path, which ran
     * without a tool registry and blocked on each tool call.
     */
    private async createGraphTurnRunner(deps: {
        readonly sessionId: string;
        readonly modelProviderSelection: ModelProviderSelection;
    }): Promise<RunCoordinatorTurnRunner> {
        const toolRegistry = await this.ensureGraphToolRegistry();
        const selection = deps.modelProviderSelection;
        const resolveSdkModel = (options: AbgNodeModelOptions) =>
            wrapFlatProviderAsSdkModel({
                provider: this.provider,
                providerID: options.providerID ?? selection.providerID,
                modelID: options.modelID,
                ...(selection.variantID !== undefined ? { variantID: selection.variantID } : {}),
            });
        return createGraphTurnRunner({
            graph: createCodingAgentGraph({ model: selectionToModelOptions(selection) }),
            sessionId: deps.sessionId,
            now: this.now,
            modelProviderSelection: selection,
            registry: createCodingAgentNodeRegistry(),
            resolveSdkModel,
            toolRegistry,
            haltOnFailedToolSettlement: true,
            // Match the flat run loop's sequential tool cadence so a multi-call batch surfaces ONE
            // pending approval at a time (the desktop approval broker's single-pending invariant).
            serializeToolExecution: true,
        });
    }

    private ensureGraphToolRegistry(): Promise<ToolRegistry> {
        if (this.graphToolRegistryPromise === undefined) {
            this.graphToolRegistryPromise = this.buildGraphToolRegistry();
        }
        return this.graphToolRegistryPromise;
    }

    private async buildGraphToolRegistry(): Promise<ToolRegistry> {
        const registry = new ToolRegistry();
        // `requires_approval` makes each tool settle `approval_required` (file-mutation maps a
        // non-allow/non-deny decision to that code) so the graph blocks on every tool call. No
        // PermissionGate is used → no gate-emitted approval events; the desktop owns those via
        // backfillCurrentBlockedDesktopApproval, exactly as the flat path did.
        const requestPermission = (request: PermissionRequest): PermissionDecision => ({
            requestId: request.id,
            status: 'requires_approval',
            reason: 'desktop approval required',
        });
        await registerFileEditTool(registry, { workspaceRoot: this.options.workspaceRoot, requestPermission });
        await registerFileWriteTool(registry, { workspaceRoot: this.options.workspaceRoot, requestPermission });
        await registerFilePatchTool(registry, { workspaceRoot: this.options.workspaceRoot, requestPermission });
        await registerCommandRunTool(registry, {
            workspaceRoot: this.options.workspaceRoot,
            requestPermission,
            ...(this.options.commandExecutor !== undefined ? { executor: this.options.commandExecutor } : {}),
        });
        return registry;
    }
}

function selectionToModelOptions(selection: ModelProviderSelection): AbgNodeModelOptions {
    return {
        providerID: selection.providerID,
        modelID: selection.modelID,
        ...(selection.variantID !== undefined ? { variantID: selection.variantID } : {}),
    };
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

function hasSettledToolContinuation(messages: readonly AgentMessage[]): boolean {
    const assistantToolCallIds = new Set<string>();
    for (const message of messages) {
        switch (message.role) {
            case 'assistant':
                for (const toolCall of message.providerToolCalls ?? []) {
                    assistantToolCallIds.add(toolCall.toolCallId);
                }
                break;
            case 'tool':
                if (assistantToolCallIds.has(message.toolCallId)) {
                    return true;
                }
                break;
            case 'system':
            case 'user':
                break;
            default:
                return assertNeverAgentMessage(message);
        }
    }
    return false;
}

function assertNeverAgentMessage(message: never): never {
    throw new TypeError(`Unexpected agent message role: ${JSON.stringify(message)}`);
}

function createDefaultDesktopProvider(): ProviderAdapter {
    return createProviderRouter(createProviderAuthStoreCredentialResolver(createProviderAuthStore()));
}

async function backfillCurrentBlockedDesktopApproval(
    store: JsonlSessionEventStore,
    sessionId: string,
    modelProviderSelection: ModelProviderSelection,
    now: () => string,
    result: { readonly status: DesktopCommandReceipt['status']; readonly toolCallId?: string },
): Promise<void> {
    if (result.status !== 'blocked_on_approval' || result.toolCallId === undefined) {
        return;
    }
    await ensureRuntimeOwnedPermissionRequestForBlockedToolCall({
        store,
        sessionId,
        modelProviderSelection,
        now,
        blockedToolCallId: result.toolCallId,
    });
    await ensurePendingToolApprovalForCurrentBlockedRun({
        store,
        sessionId,
        modelProviderSelection,
        now,
        blockedToolCallId: result.toolCallId,
    });
}
