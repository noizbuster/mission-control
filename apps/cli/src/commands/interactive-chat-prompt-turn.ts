import {
    type AgentRuntime,
    type CommandExecutionRequest,
    type CommandExecutionResult,
    type JsonlSessionEventStore,
    type ProviderAdapter,
    ProviderTurnRunner,
    prependProjectContextMessages,
    type SdkModelResolver,
} from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import type { ChatOutput } from './interactive-chat-io.js';
import { type ActiveCodingAgentTurn, startCodingAgentTurn } from './interactive-coding-agent.js';

export type PromptTurnContext = {
    readonly provider: ProviderAdapter | undefined;
    readonly sessionId: string | undefined;
    readonly workspaceRoot: string | undefined;
    readonly commandExecutor: ((request: CommandExecutionRequest) => Promise<CommandExecutionResult>) | undefined;
    readonly emitEvent: ((event: AgentEvent) => void) | undefined;
    readonly observeStoredEvent: ((event: AgentEvent) => void) | undefined;
    readonly nextTurnId: () => string;
    readonly sessionStore: JsonlSessionEventStore | undefined;
    /**
     * Execution engine for the coding-agent turn. `'graph'` drives the turn through the ABG coding-agent
     * graph (via the same `SessionRunOwner` + graph turn runner the non-interactive `--engine graph`
     * path uses); omitted/`'flat'` drives the incumbent flat provider-turn loop. The graph path needs
     * `resolveSdkModel` to resolve the AI-SDK model for the selection.
     */
    readonly engine?: 'graph' | 'flat';
    readonly resolveSdkModel?: SdkModelResolver;
};

export async function startPromptTurn(
    runtime: AgentRuntime,
    chatOutput: ChatOutput,
    prompt: string,
    modelProviderSelection: ModelProviderSelection,
    coding: PromptTurnContext,
): Promise<ActiveCodingAgentTurn | undefined> {
    if (
        coding.provider === undefined ||
        coding.sessionId === undefined ||
        coding.workspaceRoot === undefined ||
        coding.sessionStore === undefined
    ) {
        if (coding.provider !== undefined) {
            const taskId = coding.nextTurnId();
            const sessionId = coding.sessionId ?? 'interactive_session';
            await runtime.requestPermission(
                {
                    id: `permission_${taskId}`,
                    action: 'prompt.submit',
                    reason: 'user chat prompt permission gate',
                },
                taskId,
            );
            emitFallbackTaskEvent(
                coding,
                'task.started',
                sessionId,
                taskId,
                'user prompt submitted',
                modelProviderSelection,
            );
            const runner = new ProviderTurnRunner({
                provider: coding.provider,
            });
            const projectContext =
                coding.workspaceRoot !== undefined ? { workspaceRoot: coding.workspaceRoot } : undefined;
            const messages = await prependProjectContextMessages([{ role: 'user', content: prompt }], projectContext);
            const result = await runner.runTurn({
                sessionId,
                turnId: taskId,
                requestId: `provider_request_${taskId}`,
                providerID: modelProviderSelection.providerID,
                modelID: modelProviderSelection.modelID,
                ...(modelProviderSelection.variantID !== undefined
                    ? { variantID: modelProviderSelection.variantID }
                    : {}),
                messages,
                startSequence: 0,
                onEnvelope: (envelope) => {
                    if (envelope.durability === 'durable') {
                        coding.emitEvent?.(envelope.event);
                        return;
                    }
                    coding.observeStoredEvent?.(envelope.event);
                },
            });
            if (result.status === 'failed') {
                const errorMessage = result.error.message;
                emitFallbackTaskEvent(coding, 'task.failed', sessionId, taskId, errorMessage, modelProviderSelection);
                chatOutput.write(`Error: ${errorMessage}\n`);
                return undefined;
            }
            chatOutput.write(`Assistant: ${result.message.content}\n`);
            emitFallbackTaskEvent(
                coding,
                'task.completed',
                sessionId,
                taskId,
                result.message.content,
                modelProviderSelection,
            );
            return undefined;
        }
        const response = await runtime.runPromptTask(prompt);
        chatOutput.write(`Assistant: ${response}\n`);
        return undefined;
    }
    return startCodingAgentTurn({
        prompt,
        sessionId: coding.sessionId,
        turnId: coding.nextTurnId(),
        store: coding.sessionStore,
        provider: coding.provider,
        modelProviderSelection,
        workspaceRoot: coding.workspaceRoot,
        output: chatOutput,
        emitEvent: coding.emitEvent ?? (() => undefined),
        ...(coding.observeStoredEvent !== undefined ? { observeStoredEvent: coding.observeStoredEvent } : {}),
        ...(coding.commandExecutor !== undefined ? { commandExecutor: coding.commandExecutor } : {}),
        ...(coding.engine !== undefined ? { engine: coding.engine } : {}),
        ...(coding.resolveSdkModel !== undefined ? { resolveSdkModel: coding.resolveSdkModel } : {}),
    });
}

function emitFallbackTaskEvent(
    coding: PromptTurnContext,
    type: 'task.started' | 'task.completed' | 'task.failed',
    sessionId: string,
    taskId: string,
    message: string,
    modelProviderSelection: ModelProviderSelection,
): void {
    coding.emitEvent?.({
        type,
        timestamp: new Date().toISOString(),
        sessionId,
        taskId,
        message,
        nativeSidecarStatus: 'mock',
        modelProviderSelection,
    });
}
