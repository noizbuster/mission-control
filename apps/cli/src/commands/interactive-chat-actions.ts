import type {
    AgentRuntime,
    CommandExecutionRequest,
    CommandExecutionResult,
    ProviderAdapter,
} from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import type { ChatLineAction } from './chat-commands.js';
import type { ModelSelector } from './interactive-chat.js';
import type { ChatOutput } from './interactive-chat-io.js';
import type { ModelChoice } from './interactive-chat-model.js';
import { formatModelProviderStatus } from './interactive-chat-status.js';
import { type ActiveCodingAgentTurn, startCodingAgentTurn } from './interactive-coding-agent.js';

export type ChatActionResult = {
    readonly modelProviderSelection: ModelProviderSelection;
    readonly activeTurn?: ActiveCodingAgentTurn;
};

export type CodingActionContext = {
    readonly activeTurn: ActiveCodingAgentTurn | undefined;
    readonly provider: ProviderAdapter | undefined;
    readonly sessionId: string | undefined;
    readonly workspaceRoot: string | undefined;
    readonly commandExecutor: ((request: CommandExecutionRequest) => Promise<CommandExecutionResult>) | undefined;
    readonly emitEvent: ((event: AgentEvent) => void) | undefined;
    readonly nextTurnId: () => string;
};

export async function runChatAction(
    runtime: AgentRuntime,
    chatOutput: ChatOutput,
    action: ChatLineAction,
    currentModelProviderSelection: ModelProviderSelection,
    selectModel: ModelSelector,
    modelChoices: readonly ModelChoice[],
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    switch (action.kind) {
        case 'empty':
            return actionResult(currentModelProviderSelection);
        case 'prompt':
            return runPromptAction(runtime, chatOutput, action.prompt, currentModelProviderSelection, coding);
        case 'queue':
            emitPromptAdmission(chatOutput, coding, 'queue', action.prompt);
            return actionResult(currentModelProviderSelection, coding.activeTurn);
        case 'steer':
            emitPromptAdmission(chatOutput, coding, 'steer', action.prompt);
            return actionResult(currentModelProviderSelection, coding.activeTurn);
        case 'branch':
            emitPromptAdmission(chatOutput, coding, 'steer', action.prompt, action.parentMessageId);
            chatOutput.write(`Branch continue from ${action.parentMessageId}: ${action.prompt}\n`);
            return actionResult(currentModelProviderSelection, coding.activeTurn);
        case 'resume':
            emitResumeRequest(chatOutput, coding, coding.activeTurn === undefined ? 'idle' : 'running');
            return actionResult(currentModelProviderSelection, coding.activeTurn);
        case 'interrupt':
            return runInterruptAction(chatOutput, currentModelProviderSelection, coding.activeTurn);
        case 'exit':
            return actionResult(currentModelProviderSelection, coding.activeTurn);
        case 'model-status':
            chatOutput.write(formatModelProviderStatus(currentModelProviderSelection, { nodeMode: 'none' }));
            return actionResult(currentModelProviderSelection, coding.activeTurn);
        case 'model-pick':
            return runModelPickAction(
                runtime,
                chatOutput,
                currentModelProviderSelection,
                selectModel,
                modelChoices,
                coding,
            );
        case 'model-list':
            return runModelListAction(
                chatOutput,
                currentModelProviderSelection,
                modelChoices,
                action,
                coding.activeTurn,
            );
        case 'model':
            runtime.setModelProviderSelection(action.selection);
            chatOutput.write(formatModelProviderStatus(action.selection, { nodeMode: 'none' }));
            return actionResult(action.selection, coding.activeTurn);
        case 'skill':
            await runtime.runSkillInvocationTask({ skillID: action.name, argumentsText: action.instruction });
            chatOutput.write(
                `Skill ${action.name} scaffolded${action.instruction.length > 0 ? `: ${action.instruction}` : ''}\n`,
            );
            return actionResult(currentModelProviderSelection, coding.activeTurn);
        case 'unknown-slash':
            chatOutput.write(`Unknown command: /${action.command}\n`);
            return actionResult(currentModelProviderSelection, coding.activeTurn);
        case 'invalid':
            chatOutput.write(`${action.message}\n`);
            return actionResult(currentModelProviderSelection, coding.activeTurn);
        default:
            return assertNever(action);
    }
}

async function runPromptAction(
    runtime: AgentRuntime,
    chatOutput: ChatOutput,
    prompt: string,
    modelProviderSelection: ModelProviderSelection,
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    if (coding.activeTurn !== undefined) {
        emitPromptAdmission(chatOutput, coding, 'queue', prompt);
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    const activeTurn = await startPromptTurn(runtime, chatOutput, prompt, modelProviderSelection, coding);
    return actionResult(modelProviderSelection, activeTurn);
}

async function runInterruptAction(
    chatOutput: ChatOutput,
    modelProviderSelection: ModelProviderSelection,
    activeTurn: ActiveCodingAgentTurn | undefined,
): Promise<ChatActionResult> {
    if (activeTurn === undefined) {
        chatOutput.write('No active run to interrupt\n');
        return actionResult(modelProviderSelection);
    }
    activeTurn.interrupt('force');
    await activeTurn.done;
    return actionResult(modelProviderSelection);
}

async function runModelPickAction(
    runtime: AgentRuntime,
    chatOutput: ChatOutput,
    currentSelection: ModelProviderSelection,
    selectModel: ModelSelector,
    modelChoices: readonly ModelChoice[],
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    if (modelChoices.length === 0) {
        chatOutput.write('No models are available for logged-in providers\n');
        return actionResult(currentSelection, coding.activeTurn);
    }
    const selection = await selectModel(modelChoices, currentSelection);
    if (selection === undefined) {
        chatOutput.write(formatModelProviderStatus(currentSelection, { nodeMode: 'none' }));
        return actionResult(currentSelection, coding.activeTurn);
    }
    runtime.setModelProviderSelection(selection);
    chatOutput.write(formatModelProviderStatus(selection, { nodeMode: 'none' }));
    return actionResult(selection, coding.activeTurn);
}

function runModelListAction(
    chatOutput: ChatOutput,
    currentSelection: ModelProviderSelection,
    _modelChoices: readonly ModelChoice[],
    action: Extract<ChatLineAction, { readonly kind: 'model-list' }>,
    activeTurn: ActiveCodingAgentTurn | undefined,
): ChatActionResult {
    if (action.totalCount === 0) {
        chatOutput.write('No models are available for logged-in providers\n');
        return actionResult(currentSelection, activeTurn);
    }
    chatOutput.write(`Showing 1-${action.visibleChoices.length} of ${action.totalCount}\n`);
    for (const choice of action.visibleChoices) {
        chatOutput.write(`${choice.label}\n`);
    }
    return actionResult(currentSelection, activeTurn);
}

async function startPromptTurn(
    runtime: AgentRuntime,
    chatOutput: ChatOutput,
    prompt: string,
    modelProviderSelection: ModelProviderSelection,
    coding: CodingActionContext,
): Promise<ActiveCodingAgentTurn | undefined> {
    if (coding.provider === undefined || coding.sessionId === undefined || coding.workspaceRoot === undefined) {
        const response = await runtime.runPromptTask(prompt);
        chatOutput.write(`Assistant: ${response}\n`);
        return undefined;
    }
    return startCodingAgentTurn({
        prompt,
        sessionId: coding.sessionId,
        turnId: coding.nextTurnId(),
        provider: coding.provider,
        modelProviderSelection,
        workspaceRoot: coding.workspaceRoot,
        output: chatOutput,
        emitEvent: coding.emitEvent ?? (() => undefined),
        ...(coding.commandExecutor !== undefined ? { commandExecutor: coding.commandExecutor } : {}),
    });
}

function emitPromptAdmission(
    chatOutput: ChatOutput,
    coding: CodingActionContext,
    delivery: 'queue' | 'steer',
    prompt: string,
    parentMessageId?: string,
): void {
    const sessionId = coding.sessionId ?? 'interactive_session';
    const timestamp = new Date().toISOString();
    coding.emitEvent?.({
        type: 'prompt.admitted',
        timestamp,
        sessionId,
        message: prompt,
        transcript: {
            inputId: `${delivery}_${timestamp}`,
            messageId: `message_${timestamp}`,
            delivery,
            visibility: 'pending',
            ...(parentMessageId !== undefined ? { parentMessageId } : {}),
        },
    });
    if (parentMessageId === undefined) {
        chatOutput.write(`${delivery === 'queue' ? 'Queued follow-up' : 'Steering current run'}: ${prompt}\n`);
    }
}

function emitResumeRequest(chatOutput: ChatOutput, coding: CodingActionContext, state: 'idle' | 'running'): void {
    const sessionId = coding.sessionId ?? 'interactive_session';
    coding.emitEvent?.({
        type: 'run.command.received',
        timestamp: new Date().toISOString(),
        sessionId,
        message: 'run command: resume',
        run: { command: 'resume', state },
    });
    chatOutput.write(`Resume requested for ${sessionId}\n`);
}

function actionResult(
    modelProviderSelection: ModelProviderSelection,
    activeTurn?: ActiveCodingAgentTurn,
): ChatActionResult {
    return activeTurn === undefined ? { modelProviderSelection } : { modelProviderSelection, activeTurn };
}

function assertNever(value: never): never {
    throw new Error(`Unexpected chat action: ${String(value)}`);
}
