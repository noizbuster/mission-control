import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    type LocalSessionEventStore,
    type LspClient,
    PermissionGate,
    type ProviderAdapter,
    type RunCoordinatorTurnRunner,
    type SdkModelResolver,
    SessionRunOwner,
    type SessionRunOwnerReceipt,
    type TaskToolRuntimeServices,
    type ToolRegistry,
} from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import { createCliPermissionDecision, type NonInteractiveAutomationPolicy } from './cli-permission-policy.js';
import {
    getOrCreateMissionControlServices,
    isOmoRootNotFoundError,
    type MissionControlServices,
} from './mission-control-services.js';
import { createNonInteractiveToolRegistry } from './noninteractive-tool-registry.js';

export type RunOwnerPromptInput = {
    readonly sessionId: string;
    readonly store: LocalSessionEventStore;
    readonly provider: ProviderAdapter;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly workspaceRoot: string;
    readonly prompt: string;
    readonly emitEvent: (event: AgentEvent) => void;
    readonly observeStoredEvent: (event: AgentEvent) => void;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly nonInteractiveAutomationPolicy?: NonInteractiveAutomationPolicy;
    readonly throwOnTerminalFailure?: boolean;
    /**
     * Inject a turn runner to drive an alternate engine (e.g. the ABG graph via
     * `createGraphTurnRunner`) instead of the flat provider tool loop. Built AFTER the
     * permission-gated tool surface so it reuses the same `ToolRegistry` (and gate) the flat
     * path would — the graph's tool calls route through the same approval/blocking machinery.
     * Omit to drive the flat provider loop (the default).
     */
    readonly createTurnRunner?: (deps: { readonly toolRegistry: ToolRegistry }) => RunCoordinatorTurnRunner;
    /**
     * When set, the `task` subagent tool registers with a real spawn closure. The graph turn
     * runner built by `createTurnRunner` already needs a resolver; this same resolver drives the
     * child graph spawned by `task`.
     */
    readonly resolveSdkModel?: SdkModelResolver;
    /** LSP seam: inject a real `LspClient` to register the `lsp` tool. Default undefined (off). */
    readonly lspClient?: LspClient;
    readonly taskRuntimeServices?: TaskToolRuntimeServices;
};

export async function runOwnerPrompt(input: RunOwnerPromptInput): Promise<void> {
    const taskId = await nextOwnerPromptTaskId(input.store, input.sessionId);
    let finalMessage: string | undefined;
    const gate = new PermissionGate({
        resolveDecision: (request) =>
            createCliPermissionDecision(request, {
                ...(input.nonInteractiveAutomationPolicy !== undefined
                    ? { automationPolicy: input.nonInteractiveAutomationPolicy }
                    : {}),
                workspaceRoot: input.workspaceRoot,
            }),
        emit: input.emitEvent,
        now: () => new Date().toISOString(),
        pendingApprovalBehavior: 'block',
    });
    const ownedServices =
        input.taskRuntimeServices === undefined ? await resolveMissionControlServices(input.workspaceRoot) : undefined;
    const taskRuntimeServices = input.taskRuntimeServices ?? ownedServices?.getTaskRuntimeServices();
    const sessionControlHost = taskRuntimeServices?.sessionControlHost ?? ownedServices?.getSessionControlHost();
    const { registry: toolRegistry, mcpConnectionManager } = await createNonInteractiveToolRegistry({
        workspaceRoot: input.workspaceRoot,
        requestPermission: (request) =>
            gate.requestPermission(request, {
                sessionId: input.sessionId,
                taskId,
                modelProviderSelection: input.modelProviderSelection,
            }),
        ...(input.resolveSdkModel !== undefined ? { resolveSdkModel: input.resolveSdkModel } : {}),
        modelProviderSelection: input.modelProviderSelection,
        sessionId: input.sessionId,
        ...(input.commandExecutor !== undefined ? { commandExecutor: input.commandExecutor } : {}),
        ...(input.lspClient !== undefined ? { lspClient: input.lspClient } : {}),
        ...(taskRuntimeServices !== undefined ? { services: taskRuntimeServices } : {}),
    });
    // When an alternate engine is requested, build its turn runner over the SAME permission-gated
    // tool surface so the graph's tool calls honor the same approval/blocking behavior as the flat
    // loop. The coordinator owns queue/steer/resume around whichever turn runner is installed.
    const runProviderTurn = input.createTurnRunner?.({ toolRegistry });
    let owner: SessionRunOwner | undefined;
    owner = new SessionRunOwner({
        sessionId: input.sessionId,
        store: input.store,
        provider: input.provider,
        modelProviderSelection: input.modelProviderSelection,
        haltOnFailedToolSettlement: true,
        projectContext: { workspaceRoot: input.workspaceRoot },
        toolRegistry,
        ...(runProviderTurn !== undefined ? { runProviderTurn } : {}),
        onDurableEvent: (event: AgentEvent) => {
            if (event.type === 'model.call.completed') {
                finalMessage = event.message;
            }
            input.observeStoredEvent(event);
        },
        ...(sessionControlHost !== undefined ? { sessionControlHost } : {}),
    });

    emitTaskEvent(input, taskId, 'task.started', `user prompt: ${input.prompt}`);
    let receipt: SessionRunOwnerReceipt;
    try {
        receipt = await owner.submit({
            prompt: input.prompt,
            inputId: `input_${taskId}`,
            messageId: `message_${taskId}`,
        });
    } finally {
        try {
            await owner?.release();
            if (ownedServices !== undefined) {
                await sessionControlHost?.close();
            }
        } finally {
            try {
                await mcpConnectionManager.disconnectAll();
            } finally {
                await ownedServices?.dispose();
            }
        }
    }
    if (receipt.status === 'completed') {
        emitTaskEvent(input, taskId, 'task.completed', finalMessage ?? 'run completed');
        return;
    }
    if (receipt.status === 'blocked_on_approval') {
        return;
    }
    if (receipt.status === 'failed' || receipt.status === 'interrupted') {
        emitTaskEvent(input, taskId, 'task.failed', receipt.reason ?? `run ${receipt.status}`);
        if (input.throwOnTerminalFailure ?? true) {
            throw new Error(receipt.reason ?? `run ${receipt.status}`);
        }
    }
}

async function resolveMissionControlServices(workspaceRoot: string): Promise<MissionControlServices | undefined> {
    try {
        return await getOrCreateMissionControlServices(workspaceRoot);
    } catch (error: unknown) {
        if (isOmoRootNotFoundError(error)) {
            return undefined;
        }
        throw error;
    }
}

async function nextOwnerPromptTaskId(store: LocalSessionEventStore, sessionId: string): Promise<string> {
    const events = await store.getEvents(sessionId);
    let maxIndex = 0;
    for (const event of events) {
        if (event.sessionId !== sessionId) {
            continue;
        }
        maxIndex = Math.max(maxIndex, maxNumericSuffix(ownerPromptIdsFromEvent(event)));
    }
    return `task_prompt_${maxIndex + 1}`;
}

function ownerPromptIdsFromEvent(event: AgentEvent): readonly (string | undefined)[] {
    return [
        event.taskId,
        event.run?.runId,
        event.run?.inputId,
        event.run?.messageId,
        event.run?.providerTurnId,
        event.run?.toolCallId,
        event.run?.graphId,
        event.run?.nodeId,
        event.transcript?.inputId,
        event.transcript?.messageId,
        event.transcript?.providerTurnId,
        event.transcript?.toolCallId,
        event.transcript?.graphId,
        event.transcript?.nodeId,
        event.providerStreamChunk?.requestId,
    ];
}

function maxNumericSuffix(ids: readonly (string | undefined)[]): number {
    let maxIndex = 0;
    for (const id of ids) {
        const index = numericSuffix(id);
        if (index !== undefined) {
            maxIndex = Math.max(maxIndex, index);
        }
    }
    return maxIndex;
}

function numericSuffix(id: string | undefined): number | undefined {
    const match = id?.match(/_(\d+)$/u);
    if (match?.[1] === undefined) {
        return undefined;
    }
    return Number.parseInt(match[1], 10);
}

function emitTaskEvent(
    input: RunOwnerPromptInput,
    taskId: string,
    type: 'task.started' | 'task.completed' | 'task.failed',
    message: string,
): void {
    input.emitEvent({
        type,
        timestamp: new Date().toISOString(),
        sessionId: input.sessionId,
        taskId,
        message,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: input.modelProviderSelection,
    });
}
