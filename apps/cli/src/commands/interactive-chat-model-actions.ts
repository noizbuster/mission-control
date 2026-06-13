import type { AgentRuntime } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import type { ChatLineAction } from './chat-commands.js';
import type { ModelSelector } from './interactive-chat.js';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result.js';
import type { CodingActionContext } from './interactive-chat-actions.js';
import type { ChatOutput } from './interactive-chat-io.js';
import { createVariantChoices, getModelChoiceUnavailableReason, type ModelChoice } from './interactive-chat-model.js';
import { formatModelProviderStatus } from './interactive-chat-status.js';

export async function runModelPickAction(
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
    return actionResult(selectedVariant, coding.activeTurn, { persistModelProviderSelection: true });
}

export function runModelListAction(
    chatOutput: ChatOutput,
    currentSelection: ModelProviderSelection,
    action: Extract<ChatLineAction, { readonly kind: 'model-list' }>,
    activeTurn: CodingActionContext['activeTurn'],
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
