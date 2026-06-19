import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    type JsonlSessionEventStore,
    type LspClient,
    PermissionGate,
    type ProviderAdapter,
    type RunCoordinatorTurnRunner,
    type SdkModelResolver,
    SessionRunOwner,
    type SessionRunOwnerReceipt,
    type ToolRegistry,
} from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import { createCliPermissionDecision, type NonInteractiveAutomationPolicy } from './cli-permission-policy.js';
import { createNonInteractiveToolRegistry } from './noninteractive-tool-registry.js';

export type RunOwnerPromptInput = {
    readonly sessionId: string;
    readonly store: JsonlSessionEventStore;
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
};

export async function runOwnerPrompt(input: RunOwnerPromptInput): Promise<void> {
    const taskId = 'task_prompt_1';
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
    });
    // When an alternate engine is requested, build its turn runner over the SAME permission-gated
    // tool surface so the graph's tool calls honor the same approval/blocking behavior as the flat
    // loop. The coordinator owns queue/steer/resume around whichever turn runner is installed.
    const runProviderTurn = input.createTurnRunner?.({ toolRegistry });
    const owner = new SessionRunOwner({
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
        await mcpConnectionManager.disconnectAll();
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
