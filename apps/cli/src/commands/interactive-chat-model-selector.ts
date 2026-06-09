import type { ModelProviderSelection } from '@mission-control/protocol';
import {
    createProviderPromptKeypressState,
    createProviderPromptView,
    reduceProviderPromptKeypress,
} from './auth-provider-keypress.js';
import type { ChatOutput, ModelSelector } from './interactive-chat.js';
import type { ModelChoice } from './interactive-chat-model.js';
import { stdin as input, stdout as output } from 'node:process';

export function createTerminalModelSelector(chatOutput: ChatOutput): ModelSelector {
    return async (choices) => {
        if (choices.length === 0) {
            return undefined;
        }
        return questionModelLine(chatOutput, choices);
    };
}

function questionModelLine(
    chatOutput: ChatOutput,
    choices: readonly ModelChoice[],
): Promise<ModelProviderSelection | undefined> {
    const promptChoices = choices.map((choice) => ({
        id: choice.id,
        name: choice.label,
    }));

    return new Promise((resolve) => {
        let keypressState = createProviderPromptKeypressState();
        let renderedLines = 0;

        function clearPreviousRender(): void {
            if (renderedLines > 0) {
                chatOutput.write(`\u001b[${renderedLines}F\u001b[0J`);
            }
        }

        function render(): void {
            clearPreviousRender();
            const view = createProviderPromptView(keypressState, promptChoices, getVisibleModelChoiceCount());
            chatOutput.write('Select model\n');
            chatOutput.write(`Search: ${view.searchQuery}\n`);
            if (view.totalCount === 0) {
                chatOutput.write('No models match\n');
            } else {
                chatOutput.write(`Showing ${view.startIndex + 1}-${view.endIndex} of ${view.totalCount}\n`);
            }
            for (const [visibleIndex, choice] of view.visibleChoices.entries()) {
                const choiceIndex = view.startIndex + visibleIndex;
                const marker = choiceIndex === view.selectedIndex ? '>' : ' ';
                chatOutput.write(`${marker} ${choiceIndex + 1}. ${choice.name}\n`);
            }
            chatOutput.write('Use Up/Down, type to search, Enter to select\n');
            renderedLines = 4 + view.visibleChoices.length;
        }

        function finish(selection: ModelProviderSelection | undefined): void {
            input.off('data', onData);
            chatOutput.write('\n');
            resolve(selection);
        }

        function onData(chunk: Buffer | string): void {
            const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            const nextState = reduceProviderPromptKeypress(keypressState, text, promptChoices);
            const shouldRender =
                keypressState.selectedIndex !== nextState.selectedIndex ||
                keypressState.searchQuery !== nextState.searchQuery;
            keypressState = nextState;

            if (keypressState.cancelled) {
                finish(undefined);
                return;
            }
            if (shouldRender) {
                render();
            }
            if (keypressState.submitted) {
                const view = createProviderPromptView(keypressState, promptChoices, getVisibleModelChoiceCount());
                finish(choices.find((choice) => choice.id === view.filteredChoices[view.selectedIndex]?.id)?.selection);
            }
        }

        render();
        input.on('data', onData);
    });
}

function getVisibleModelChoiceCount(): number {
    const terminalRows = output.rows;
    if (terminalRows === undefined) {
        return 12;
    }
    return Math.min(12, Math.max(5, terminalRows - 5));
}
