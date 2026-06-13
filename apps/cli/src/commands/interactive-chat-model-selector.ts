import type { ModelProviderSelection } from '@mission-control/protocol';
import {
    createProviderPromptKeypressState,
    createProviderPromptView,
    reduceProviderPromptKeypress,
} from './auth-provider-keypress.js';
import type { TerminalInputStream, TerminalOutputStream } from './interactive-chat-terminal-read.js';
import type { ChatOutput, ModelSelector } from './interactive-chat.js';
import type { ModelChoice } from './interactive-chat-model.js';
import { truncateTerminalText } from './terminal-text.js';
import { stdin, stdout } from 'node:process';

export type ModelSelectorRenderInput = {
    readonly title: string;
    readonly view: ReturnType<typeof createProviderPromptView>;
    readonly columns: number;
};

export type ModelSelectorOutputStream = TerminalOutputStream & {
    readonly rows?: number;
    readonly columns?: number;
};

export type ModelSelectorStreams = {
    readonly input: TerminalInputStream;
    readonly output: ModelSelectorOutputStream;
};

export function createTerminalModelSelector(chatOutput: ChatOutput): ModelSelector {
    return createTerminalModelSelectorFromStreams(chatOutput, { input: stdin, output: stdout });
}

export function createTerminalModelSelectorFromStreams(
    chatOutput: ChatOutput,
    streams: ModelSelectorStreams,
): ModelSelector {
    return async (choices, _currentSelection, options) => {
        if (choices.length === 0) {
            return undefined;
        }
        return questionModelLine(chatOutput, choices, options?.title ?? 'Select model', streams);
    };
}

function questionModelLine(
    chatOutput: ChatOutput,
    choices: readonly ModelChoice[],
    title: string,
    streams: ModelSelectorStreams,
): Promise<ModelProviderSelection | undefined> {
    const promptChoices = choices.map((choice) => ({
        id: choice.id,
        name: choice.label,
    }));

    const wasRaw = streams.input.isRaw === true;
    streams.input.setRawMode(true);
    streams.input.resume();

    return new Promise((resolve) => {
        let keypressState = createProviderPromptKeypressState();
        let renderedLines = 0;
        let cleaned = false;

        function clearPreviousRender(): void {
            if (renderedLines > 0) {
                chatOutput.write(`\u001b[${renderedLines}F\u001b[0J`);
            }
        }

        function render(): void {
            clearPreviousRender();
            const view = createProviderPromptView(keypressState, promptChoices, getVisibleModelChoiceCount());
            const lines = renderModelSelectorLines({
                title,
                view,
                columns: getTerminalColumns(),
            });
            for (const line of lines) {
                chatOutput.write(`${line}\n`);
            }
            renderedLines = lines.length;
        }

        function cleanup(): void {
            if (cleaned) {
                return;
            }
            cleaned = true;
            streams.input.off('data', onData);
            streams.input.setRawMode(wasRaw);
            streams.input.pause();
        }

        function finish(selection: ModelProviderSelection | undefined): void {
            cleanup();
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

        function getVisibleModelChoiceCount(): number {
            const terminalRows = streams.output.rows;
            if (terminalRows === undefined) {
                return 12;
            }
            return Math.min(12, Math.max(5, terminalRows - 5));
        }

        function getTerminalColumns(): number {
            return streams.output.columns ?? 80;
        }

        render();
        streams.input.on('data', onData);
    });
}

export function renderModelSelectorLines(input: ModelSelectorRenderInput): readonly string[] {
    const lines = [
        input.title,
        `Search: ${input.view.searchQuery}`,
        input.view.totalCount === 0
            ? 'No models match'
            : `Showing ${input.view.startIndex + 1}-${input.view.endIndex} of ${input.view.totalCount}`,
        ...input.view.visibleChoices.map((choice, visibleIndex) => {
            const choiceIndex = input.view.startIndex + visibleIndex;
            const marker = choiceIndex === input.view.selectedIndex ? '>' : ' ';
            return `${marker} ${choiceIndex + 1}. ${choice.name}`;
        }),
        'Use Up/Down, type to search, Enter to select',
    ];
    return lines.map((line) => truncateTerminalText(line, input.columns));
}
