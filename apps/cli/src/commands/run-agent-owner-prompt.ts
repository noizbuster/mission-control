import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    type JsonlSessionEventStore,
    PermissionGate,
    type ProviderAdapter,
    SessionRunOwner,
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
};

export async function runOwnerPrompt(input: RunOwnerPromptInput): Promise<void> {
    const taskId = 'task_prompt_1';
    let finalMessage: string | undefined;
    const gate = new PermissionGate({
        resolveDecision: (request) => createCliPermissionDecision(request, input.nonInteractiveAutomationPolicy),
        emit: input.emitEvent,
        now: () => new Date().toISOString(),
        pendingApprovalBehavior: 'block',
    });
    const owner = new SessionRunOwner({
        sessionId: input.sessionId,
        store: input.store,
        provider: input.provider,
        modelProviderSelection: input.modelProviderSelection,
        toolRegistry: await createNonInteractiveToolRegistry({
            workspaceRoot: input.workspaceRoot,
            requestPermission: (request) =>
                gate.requestPermission(request, {
                    sessionId: input.sessionId,
                    taskId,
                    modelProviderSelection: input.modelProviderSelection,
                }),
            ...(input.commandExecutor !== undefined ? { commandExecutor: input.commandExecutor } : {}),
        }),
        onDurableEvent: (event: AgentEvent) => {
            if (event.type === 'model.call.completed') {
                finalMessage = event.message;
            }
            input.observeStoredEvent(event);
        },
    });

    emitTaskEvent(input, taskId, 'task.started', `user prompt: ${input.prompt}`);
    const receipt = await owner.submit({
        prompt: input.prompt,
        inputId: `input_${taskId}`,
        messageId: `message_${taskId}`,
    });
    if (receipt.status === 'completed') {
        emitTaskEvent(input, taskId, 'task.completed', finalMessage ?? 'run completed');
        return;
    }
    if (receipt.status === 'blocked_on_approval') {
        emitTaskEvent(input, taskId, 'task.failed', receipt.reason ?? 'approval required');
        return;
    }
    if (receipt.status === 'failed' || receipt.status === 'interrupted') {
        emitTaskEvent(input, taskId, 'task.failed', receipt.reason ?? `run ${receipt.status}`);
        throw new Error(receipt.reason ?? `run ${receipt.status}`);
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
