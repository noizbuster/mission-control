import type { ModelProviderSelection } from '@mission-control/protocol';
import type { SlashCommandMenuState } from './interactive-chat-command-menu.js';
import {
    formatTerminalChatCommittedInputLine,
    renderTerminalChatInputBlock,
    type TerminalChatInputBlock,
    type TerminalChatInputBuffer,
    type TerminalChatInputStatus,
} from './interactive-chat-input-block.js';

export type ChatInputRenderContext = {
    readonly modelProviderSelection?: ModelProviderSelection;
};

export type TerminalInputBlockOutput = {
    readonly columns?: number;
    readonly write: (text: string) => unknown;
};

export const emptyRenderedInputBlock = {
    text: '',
    lineCount: 0,
    cursorLineIndex: 0,
} satisfies TerminalChatInputBlock;

export function renderTerminalInputBlock(
    output: TerminalInputBlockOutput,
    buffer: TerminalChatInputBuffer,
    state: SlashCommandMenuState,
    previousBlock: TerminalChatInputBlock,
    context: ChatInputRenderContext | undefined,
): TerminalChatInputBlock {
    eraseTerminalInputBlock(output, previousBlock);
    const nextBlock = renderTerminalChatInputBlock(
        buffer,
        state,
        output.columns ?? 100,
        toTerminalChatInputStatus(context),
    );
    output.write(nextBlock.text);
    return nextBlock;
}

export function commitTerminalInputBlock(
    output: TerminalInputBlockOutput,
    value: string,
    renderedBlock: TerminalChatInputBlock,
): void {
    eraseTerminalInputBlock(output, renderedBlock);
    output.write(`${formatTerminalChatCommittedInputLine(value, output.columns ?? 100)}\n`);
}

export function discardTerminalInputBlock(
    output: TerminalInputBlockOutput,
    renderedBlock: TerminalChatInputBlock,
): void {
    eraseTerminalInputBlock(output, renderedBlock);
}

function eraseTerminalInputBlock(output: TerminalInputBlockOutput, block: TerminalChatInputBlock): void {
    if (block.lineCount <= 0) {
        return;
    }
    const cursorLineIndex = Math.min(Math.max(0, block.cursorLineIndex), block.lineCount - 1);
    output.write('\r\u001b[2K');
    for (let index = 0; index < cursorLineIndex; index += 1) {
        output.write('\u001b[1A\u001b[2K');
    }
    for (let index = 1; index < block.lineCount; index += 1) {
        output.write('\u001b[1B\u001b[2K');
    }
    for (let index = 1; index < block.lineCount; index += 1) {
        output.write('\u001b[1A');
    }
    output.write('\r');
}

function toTerminalChatInputStatus(context: ChatInputRenderContext | undefined): TerminalChatInputStatus | undefined {
    if (context?.modelProviderSelection === undefined) {
        return undefined;
    }
    return {
        providerID: context.modelProviderSelection.providerID,
        modelID: context.modelProviderSelection.modelID,
        ...(context.modelProviderSelection.variantID !== undefined
            ? { variantID: context.modelProviderSelection.variantID }
            : {}),
    };
}
