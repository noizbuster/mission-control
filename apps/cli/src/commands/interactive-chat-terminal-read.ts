import {
    createSlashCommandMenuState,
    createSlashCommandMenuView,
    reduceSlashCommandMenuSelection,
    resolveSlashCommandMenuSubmission,
    type SlashCommandMenuState,
} from './interactive-chat-command-menu.js';
import {
    deleteTerminalChatInputCharacterBeforeCursor,
    insertTerminalChatInputText,
    moveTerminalChatInputCursor,
    type TerminalChatInputBlock,
    type TerminalChatInputBuffer,
} from './interactive-chat-input-block.js';
import type { ChatInputEvent } from './interactive-chat-io.js';
import { isTerminalShiftEnterSequence, type TerminalKeyboardMode } from './interactive-chat-keyboard.js';
import { isTerminalInterruptToken, readTerminalCursorDirection } from './interactive-chat-terminal-keys.js';
import {
    type ChatInputRenderContext,
    commitTerminalInputBlock,
    discardTerminalInputBlock,
    renderTerminalInputBlock,
} from './interactive-chat-terminal-renderer.js';

export type TerminalInputStream = {
    readonly isRaw?: boolean;
    readonly setRawMode: (isRaw: boolean) => void;
    readonly resume: () => void;
    readonly pause: () => void;
    readonly on: (event: 'data', listener: (chunk: Buffer | string) => void) => TerminalInputStream;
    readonly off: (event: 'data', listener: (chunk: Buffer | string) => void) => TerminalInputStream;
};

export type TerminalOutputStream = {
    readonly write: (text: string) => void;
};

export type TerminalReadState = {
    readonly getBuffer: () => TerminalChatInputBuffer;
    readonly getMenuState: () => SlashCommandMenuState;
    readonly getRenderContext: () => ChatInputRenderContext | undefined;
    readonly getKeyboardMode: () => TerminalKeyboardMode;
    readonly setBuffer: (buffer: TerminalChatInputBuffer) => void;
    readonly setMenuState: (state: SlashCommandMenuState) => void;
    readonly getRenderedBlock: () => TerminalChatInputBlock;
    readonly setRenderedBlock: (block: TerminalChatInputBlock) => void;
    readonly readBufferedTokens: () => readonly string[];
    readonly pushBufferedTokens: (tokens: readonly string[]) => void;
    readonly readTokens: (chunk: Buffer | string) => readonly string[];
    readonly shouldCoalesceInterruptToken: (token: string) => boolean;
    readonly input: TerminalInputStream;
    readonly output: TerminalOutputStream;
    readonly resetLineState: () => void;
    readonly registerCancel?: (cancel: () => void) => () => void;
};

export function readTerminalChatEvent(state: TerminalReadState): Promise<ChatInputEvent> {
    return new Promise((resolve) => {
        let settled = false;
        let submitting = false;
        let pendingSubmitTimer: ReturnType<typeof setTimeout> | undefined;
        let unregisterCancel: (() => void) | undefined;

        function finish(event: ChatInputEvent): void {
            if (settled) {
                return;
            }
            settled = true;
            if (pendingSubmitTimer !== undefined) {
                clearTimeout(pendingSubmitTimer);
            }
            state.input.off('data', onData);
            unregisterCancel?.();
            resolve(event);
        }

        function submitLine(): void {
            if (pendingSubmitTimer !== undefined) {
                return;
            }
            submitting = true;
            pendingSubmitTimer = setTimeout(() => {
                pendingSubmitTimer = setTimeout(() => {
                    const value = resolveSlashCommandMenuSubmission(state.getBuffer().value, state.getMenuState());
                    commitTerminalInputBlock(state.output, value, state.getRenderedBlock());
                    state.resetLineState();
                    finish({ type: 'line', value });
                }, 0);
            }, 0);
        }

        function onData(chunk: Buffer | string): void {
            const tokens = state.readTokens(chunk);
            if (submitting) {
                state.pushBufferedTokens(tokens);
                return;
            }
            processInputTokens(tokens);
        }

        function processInputTokens(tokens: readonly string[]): void {
            for (let index = 0; index < tokens.length; index += 1) {
                const character = tokens[index] ?? '';
                const remainingTokens = tokens.slice(index + 1);
                if (isTerminalInterruptToken(character)) {
                    const nextTokens = dropLeadingInterruptTokens(remainingTokens);
                    if (state.shouldCoalesceInterruptToken(character)) {
                        processInputTokens(nextTokens);
                        return;
                    }
                    interruptTerminalInput(state, nextTokens, finish);
                    return;
                }
                if (handleTerminalInputToken(character, remainingTokens, state, submitLine)) {
                    return;
                }
            }
        }

        function cancelRead(): void {
            discardTerminalInputBlock(state.output, state.getRenderedBlock());
            state.resetLineState();
            finish({ type: 'interrupt' });
        }

        unregisterCancel = state.registerCancel?.(cancelRead);
        processInputTokens(state.readBufferedTokens());
        if (settled) {
            return;
        }
        state.input.on('data', onData);
    });
}

function handleTerminalInputToken(
    character: string,
    remainingTokens: readonly string[],
    state: TerminalReadState,
    submitLine: () => void,
): boolean {
    if (character.startsWith('\u001b')) {
        handleTerminalEscape(character, state);
        return false;
    }
    if (isTerminalShiftEnterSequence(character, state.getKeyboardMode())) {
        insertTerminalInputText('\n', state);
        return false;
    }
    if (character === '\n' || character === '\r') {
        if (state.getBuffer().value.trim().length === 0) {
            return false;
        }
        state.pushBufferedTokens(remainingTokens);
        submitLine();
        return true;
    }
    if (character === '\b' || character === '\u007f') {
        removeTerminalInputCharacter(state);
        return false;
    }
    insertTerminalInputText(character, state);
    return false;
}

function interruptTerminalInput(
    state: TerminalReadState,
    remainingTokens: readonly string[],
    finish: (event: ChatInputEvent) => void,
): void {
    const interruptedPartialInput = state.getBuffer().value.length > 0;
    state.pushBufferedTokens(dropLeadingInterruptTokens(remainingTokens));
    discardTerminalInputBlock(state.output, state.getRenderedBlock());
    state.resetLineState();
    finish({
        type: 'interrupt',
        ...(interruptedPartialInput ? { interruptedPartialInput } : {}),
    });
}

function dropLeadingInterruptTokens(tokens: readonly string[]): readonly string[] {
    const nextMeaningfulTokenIndex = tokens.findIndex((token) => !isTerminalInterruptToken(token));
    return nextMeaningfulTokenIndex === -1 ? [] : tokens.slice(nextMeaningfulTokenIndex);
}

function handleTerminalEscape(text: string, state: TerminalReadState): void {
    if (isTerminalShiftEnterSequence(text, state.getKeyboardMode())) {
        insertTerminalInputText('\n', state);
        return;
    }
    const cursorDirection = readTerminalCursorDirection(text);
    const menuView = createSlashCommandMenuView(state.getBuffer().value, state.getMenuState(), 5);
    if (menuView.open && (cursorDirection === 'up' || cursorDirection === 'down')) {
        const nextState = reduceSlashCommandMenuSelection(state.getMenuState(), text, state.getBuffer().value);
        state.setMenuState(nextState);
        rerenderTerminalInputBlock(state);
        return;
    }
    if (cursorDirection !== undefined) {
        state.setBuffer(moveTerminalChatInputCursor(state.getBuffer(), cursorDirection));
        rerenderTerminalInputBlock(state);
    }
}

function insertTerminalInputText(text: string, state: TerminalReadState): void {
    if (state.getBuffer().value.length + text.length > maxChatPromptLength) {
        state.output.write('\u0007');
        return;
    }
    const nextBuffer = insertTerminalChatInputText(state.getBuffer(), text);
    state.setBuffer(nextBuffer);
    state.setMenuState(createSlashCommandMenuState());
    rerenderTerminalInputBlock(state);
}

function removeTerminalInputCharacter(state: TerminalReadState): void {
    const nextBuffer = deleteTerminalChatInputCharacterBeforeCursor(state.getBuffer());
    if (nextBuffer === state.getBuffer()) {
        return;
    }
    state.setBuffer(nextBuffer);
    state.setMenuState(createSlashCommandMenuState());
    rerenderTerminalInputBlock(state);
}

function rerenderTerminalInputBlock(state: TerminalReadState): void {
    state.setRenderedBlock(
        renderTerminalInputBlock(
            state.output,
            state.getBuffer(),
            state.getMenuState(),
            state.getRenderedBlock(),
            state.getRenderContext(),
        ),
    );
}

const maxChatPromptLength = 8_000;
