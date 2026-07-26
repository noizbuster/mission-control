import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    createObservabilityRedactor,
    createProviderAuthStoreObservabilityRedactor,
    type LocalSessionEventStore,
    type LspClient,
    type ObservabilityRedactor,
    PermissionGate,
    type ProviderAdapter,
    type ProviderAuthStore,
    type RunCoordinatorTurnRunner,
    redactAgentEventForObservability,
    type SdkModelResolver,
    SessionRunOwner,
    type SessionRunOwnerReceipt,
    type TaskToolRuntimeServices,
    type ToolRegistry,
} from '@mission-control/core';
import type { AgentEvent, MissionControlConfig, ModelProviderSelection } from '@mission-control/protocol';
import { createCliPermissionDecision, type NonInteractiveAutomationPolicy } from './cli-permission-policy';
import { createGraphObservabilityRedactor } from './graph-observability-redactor';
import { resolveMissionControlServices } from './mission-control-services-resolver';
import { createNonInteractiveToolRegistry } from './noninteractive-tool-registry';
import { closeProductionToolRegistry, type ProductionToolRegistry } from './production-tool-registry';
import { emitOwnerPromptTaskEvent, nextOwnerPromptTaskId } from './run-agent-owner-prompt-events';
import { isWorkspaceTrusted } from './cli-trust';

export type RunOwnerPromptInput = {
    readonly sessionId: string;
    readonly store: LocalSessionEventStore;
    readonly provider: ProviderAdapter;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly workspaceRoot: string;
    readonly config?: MissionControlConfig;
    readonly prompt: string;
    readonly emitEvent: (event: AgentEvent) => void;
    readonly observeStoredEvent: (event: AgentEvent) => void;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly nonInteractiveAutomationPolicy?: NonInteractiveAutomationPolicy;
    /**
     * Inject a turn runner to drive an alternate engine (e.g. the ABG graph via
     * `createGraphTurnRunner`) instead of the flat provider tool loop. Built AFTER the
     * permission-gated tool surface so it reuses the same `ToolRegistry` (and gate) the flat
     * path would — the graph's tool calls route through the same approval/blocking machinery.
     * Omit to drive the flat provider loop (the default).
     */
    readonly createTurnRunner?: (deps: {
        readonly toolRegistry: ToolRegistry;
        readonly observabilityRedactor: ObservabilityRedactor;
    }) => RunCoordinatorTurnRunner;
    /**
     * When set, the `task` subagent tool registers with a real spawn closure. The graph turn
     * runner built by `createTurnRunner` already needs a resolver; this same resolver drives the
     * child graph spawned by `task`.
     */
    readonly resolveSdkModel?: SdkModelResolver;
    /** LSP seam: inject a real `LspClient` to register the `lsp` tool. Default undefined (off). */
    readonly lspClient?: LspClient;
    readonly taskRuntimeServices?: TaskToolRuntimeServices;
    readonly authStore?: ProviderAuthStore;
    readonly profileName?: string;
};

export type RunOwnerPromptResult = {
    readonly status: 'completed' | 'blocked' | 'failed' | 'cancelled';
    readonly runId?: string;
    readonly reason?: string;
};

export async function runOwnerPrompt(input: RunOwnerPromptInput): Promise<RunOwnerPromptResult> {
    const taskId = await nextOwnerPromptTaskId(input.store, input.sessionId);
    let finalMessage: string | undefined;
    let activeObservabilityRedactor =
        input.authStore === undefined
            ? createObservabilityRedactor()
            : await createProviderAuthStoreObservabilityRedactor(input.authStore);
    const gate = new PermissionGate({
        resolveDecision: (request) =>
            createCliPermissionDecision(request, {
                ...(input.nonInteractiveAutomationPolicy !== undefined
                    ? { automationPolicy: input.nonInteractiveAutomationPolicy }
                    : {}),
                workspaceRoot: input.workspaceRoot,
            }),
        emit: (event) => input.emitEvent(redactAgentEventForObservability(event, activeObservabilityRedactor)),
        now: () => new Date().toISOString(),
        pendingApprovalBehavior: 'block',
    });
    const ownedServices =
        input.taskRuntimeServices === undefined
            ? await resolveMissionControlServices(input.workspaceRoot, {
                  observabilityRedactor: activeObservabilityRedactor,
              })
            : undefined;
    const taskRuntimeServices = input.taskRuntimeServices ?? ownedServices?.getTaskRuntimeServices();
    const sessionControlHost = taskRuntimeServices?.sessionControlHost ?? ownedServices?.getSessionControlHost();
    let tools: ProductionToolRegistry | undefined;
    let owner: SessionRunOwner | undefined;
    let receipt: SessionRunOwnerReceipt;
    try {
        tools = await createNonInteractiveToolRegistry({
            workspaceRoot: input.workspaceRoot,
            config: input.config ?? {},
            enableTrustedBash: await isWorkspaceTrusted(input.workspaceRoot),
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
            ...(input.authStore !== undefined ? { authStore: input.authStore } : {}),
            ...(taskRuntimeServices !== undefined ? { services: taskRuntimeServices } : {}),
            ...(input.profileName !== undefined ? { profileName: input.profileName } : {}),
        });
        const observabilityRedactor = await createGraphObservabilityRedactor({
            mcpConnectionManager: tools.mcpConnectionManager,
            ...(input.authStore !== undefined ? { authStore: input.authStore } : {}),
        });
        activeObservabilityRedactor = observabilityRedactor;
        const runProviderTurn = input.createTurnRunner?.({
            toolRegistry: tools.registry,
            observabilityRedactor,
        });
        owner = new SessionRunOwner({
            sessionId: input.sessionId,
            store: input.store,
            provider: input.provider,
            modelProviderSelection: input.modelProviderSelection,
            haltOnFailedToolSettlement: true,
            projectContext: { workspaceRoot: input.workspaceRoot },
            toolRegistry: tools.registry,
            observabilityRedactor,
            ...(runProviderTurn !== undefined ? { runProviderTurn } : {}),
            onDurableEvent: (event: AgentEvent) => {
                if (event.type === 'model.call.completed') {
                    finalMessage = event.message;
                }
                input.observeStoredEvent(event);
            },
            ...(sessionControlHost !== undefined ? { sessionControlHost } : {}),
        });
        emitOwnerPromptTaskEvent(
            input,
            taskId,
            'task.started',
            `user prompt: ${input.prompt}`,
            activeObservabilityRedactor,
        );
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
                if (tools !== undefined) await closeProductionToolRegistry(tools);
            } finally {
                await ownedServices?.dispose();
            }
        }
    }
    if (receipt.status === 'completed') {
        emitOwnerPromptTaskEvent(
            input,
            taskId,
            'task.completed',
            finalMessage ?? 'run completed',
            activeObservabilityRedactor,
        );
        return resultFromReceipt('completed', receipt);
    }
    if (receipt.status === 'blocked_on_approval') {
        return resultFromReceipt('blocked', receipt);
    }
    if (receipt.status === 'interrupted') {
        emitOwnerPromptTaskEvent(
            input,
            taskId,
            'task.failed',
            receipt.reason ?? `run ${receipt.status}`,
            activeObservabilityRedactor,
        );
        return resultFromReceipt('cancelled', receipt);
    }
    if (receipt.status === 'failed') {
        emitOwnerPromptTaskEvent(
            input,
            taskId,
            'task.failed',
            receipt.reason ?? `run ${receipt.status}`,
            activeObservabilityRedactor,
        );
        return resultFromReceipt('failed', receipt);
    }
    return resultFromReceipt('failed', receipt);
}


function resultFromReceipt(
    status: RunOwnerPromptResult['status'],
    receipt: SessionRunOwnerReceipt,
): RunOwnerPromptResult {
    return {
        status,
        ...(receipt.runId !== undefined ? { runId: receipt.runId } : {}),
        ...(receipt.reason !== undefined ? { reason: receipt.reason } : {}),
    };
}
