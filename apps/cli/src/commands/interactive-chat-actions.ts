import type { AgentRuntime } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import type { ChatLineAction } from './chat-commands.js';
import type { ModelSelector } from './interactive-chat.js';
import type { ChatOutput } from './interactive-chat-io.js';
import { createVariantChoices, getModelChoiceUnavailableReason, type ModelChoice } from './interactive-chat-model.js';
import { type PromptTurnContext, startPromptTurn } from './interactive-chat-prompt-turn.js';
import { formatModelProviderStatus } from './interactive-chat-status.js';
import type { ActiveCodingAgentTurn } from './interactive-coding-agent.js';

export type ChatActionResult = {
    readonly modelProviderSelection: ModelProviderSelection;
    readonly activeTurn?: ActiveCodingAgentTurn;
};

export type CodingActionContext = PromptTurnContext & {
    readonly activeTurn: ActiveCodingAgentTurn | undefined;
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
    const selection = await selectModel(modelChoices, currentSelection, { title: 'Select model' });
    if (selection === undefined) {
        chatOutput.write(formatModelProviderStatus(currentSelection, { nodeMode: 'none' }));
        return actionResult(currentSelection, coding.activeTurn);
    }
    const unavailableReason = getModelChoiceUnavailableReason(modelChoices, selection);
    if (unavailableReason !== undefined) {
        chatOutput.write(`${unavailableReason}\n`);
        chatOutput.write(formatModelProviderStatus(currentSelection, { nodeMode: 'none' }));
        return actionResult(currentSelection, coding.activeTurn);
    }
    const variantChoices = createVariantChoices(selection);
    const selectedVariant =
        variantChoices.length === 0
            ? selection
            : await selectModel(variantChoices, selection, { title: 'Select variant' });
    if (selectedVariant === undefined) {
        chatOutput.write(formatModelProviderStatus(currentSelection, { nodeMode: 'none' }));
        return actionResult(currentSelection, coding.activeTurn);
    }
    runtime.setModelProviderSelection(selectedVariant);
    chatOutput.write(formatModelProviderStatus(selectedVariant, { nodeMode: 'none' }));
    return actionResult(selectedVariant, coding.activeTurn);
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
