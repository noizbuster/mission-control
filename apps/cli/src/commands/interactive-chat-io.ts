import {
    createSlashCommandMenuState,
    createSlashCommandMenuView,
    reduceSlashCommandMenuSelection,
    resolveSlashCommandMenuSubmission,
    type SlashCommandMenuState,
} from './interactive-chat-command-menu.js';
import {
    createTerminalChatInputBuffer,
    deleteTerminalChatInputCharacterBeforeCursor,
    insertTerminalChatInputText,
    moveTerminalChatInputCursor,
    type TerminalChatCursorDirection,
    type TerminalChatInputBlock,
    type TerminalChatInputBuffer,
} from './interactive-chat-input-block.js';
import {
    isTerminalShiftEnterSequence,
    type TerminalKeyboardMode,
    terminalModifiedKeyDisableSequence,
    terminalModifiedKeyEnableSequence,
} from './interactive-chat-keyboard.js';
import {
    type ChatInputRenderContext,
    commitTerminalInputBlock,
    discardTerminalInputBlock,
    emptyRenderedInputBlock,
    renderTerminalInputBlock,
} from './interactive-chat-terminal-renderer.js';
import { stdin as input, stdout as output } from 'node:process';
import { segmentTerminalText } from './terminal-text.js';

export type { ChatInputRenderContext } from './interactive-chat-terminal-renderer.js';

export type ChatInputEvent =
    | {
          readonly type: 'line';
          readonly value: string;
      }
    | {
          readonly type: 'interrupt';
          readonly interruptedPartialInput?: boolean;
      };

export type ChatInput = {
    readonly read: () => Promise<ChatInputEvent>;
    readonly close: () => void;
    readonly controlsPrompt?: boolean;
    readonly renderPrompt?: (context?: ChatInputRenderContext) => void;
};

export type ChatOutput = {
    readonly write: (text: string) => void;
    readonly getOutput?: () => string;
};

export const maxChatPromptLength = 8_000;

export function createTerminalChatOutput(): ChatOutput {
    return {
        write: (text: string) => {
            output.write(text);
        },
    };
}

export function createTerminalChatInput(): ChatInput {
    const wasRaw = input.isRaw === true;
    let closed = false;
    let buffer = createTerminalChatInputBuffer();
    let menuState = createSlashCommandMenuState();
    let renderedBlock = emptyRenderedInputBlock;
    let promptRendered = false;
    let renderContext: ChatInputRenderContext | undefined;
    const keyboardMode = { modifiedKeysEnabled: true } satisfies TerminalKeyboardMode;
    input.setRawMode(true);
    input.resume();
    output.write(terminalModifiedKeyEnableSequence);

    function resetLineState(): void {
        buffer = createTerminalChatInputBuffer();
        menuState = createSlashCommandMenuState();
        renderedBlock = emptyRenderedInputBlock;
        promptRendered = false;
    }

    function renderPrompt(context?: ChatInputRenderContext): void {
        renderContext = context;
        if (!promptRendered) {
            buffer = createTerminalChatInputBuffer();
            menuState = createSlashCommandMenuState();
            promptRendered = true;
        }
        renderedBlock = renderTerminalInputBlock(output, buffer, menuState, renderedBlock, renderContext);
    }

    return {
        controlsPrompt: true,
        renderPrompt,
        read: async () => {
            if (closed) {
                return { type: 'interrupt' };
            }
            if (!promptRendered) {
                renderPrompt();
            }
            return readTerminalChatEvent({
                getBuffer: () => buffer,
                getMenuState: () => menuState,
                getRenderContext: () => renderContext,
                getKeyboardMode: () => keyboardMode,
                setBuffer: (nextBuffer) => {
                    buffer = nextBuffer;
                },
                setMenuState: (nextState) => {
                    menuState = nextState;
                },
                getRenderedBlock: () => renderedBlock,
                setRenderedBlock: (nextBlock) => {
                    renderedBlock = nextBlock;
                },
                resetLineState,
            });
        },
        close: () => {
            if (closed) {
                return;
            }
            closed = true;
            output.write(terminalModifiedKeyDisableSequence);
            input.setRawMode(wasRaw);
            input.pause();
        },
    };
}

type TerminalReadState = {
    readonly getBuffer: () => TerminalChatInputBuffer;
    readonly getMenuState: () => SlashCommandMenuState;
    readonly getRenderContext: () => ChatInputRenderContext | undefined;
    readonly getKeyboardMode: () => TerminalKeyboardMode;
    readonly setBuffer: (buffer: TerminalChatInputBuffer) => void;
    readonly setMenuState: (state: SlashCommandMenuState) => void;
    readonly getRenderedBlock: () => TerminalChatInputBlock;
    readonly setRenderedBlock: (block: TerminalChatInputBlock) => void;
    readonly resetLineState: () => void;
};

function readTerminalChatEvent(state: TerminalReadState): Promise<ChatInputEvent> {
    return new Promise((resolve) => {
        let settled = false;
        let pendingSubmitTimer: ReturnType<typeof setTimeout> | undefined;

        function finish(event: ChatInputEvent): void {
            if (settled) {
                return;
            }
            settled = true;
            if (pendingSubmitTimer !== undefined) {
                clearTimeout(pendingSubmitTimer);
            }
            input.off('data', onData);
            resolve(event);
        }

        function scheduleSubmit(): void {
            if (pendingSubmitTimer !== undefined) {
                return;
            }
            pendingSubmitTimer = setTimeout(() => {
                pendingSubmitTimer = setTimeout(() => {
                    const value = resolveSlashCommandMenuSubmission(state.getBuffer().value, state.getMenuState());
                    commitTerminalInputBlock(output, value, state.getRenderedBlock());
                    state.resetLineState();
                    finish({ type: 'line', value });
                }, 0);
            }, 0);
        }

        function onData(chunk: Buffer | string): void {
            const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            if (text.startsWith('\u001b')) {
                handleTerminalEscape(text, state);
                return;
            }
            for (const { segment: character } of segmentTerminalText(text)) {
                if (character === '\u0003') {
                    const interruptedPartialInput = state.getBuffer().value.length > 0;
                    discardTerminalInputBlock(output, state.getRenderedBlock());
                    state.resetLineState();
                    finish({
                        type: 'interrupt',
                        ...(interruptedPartialInput ? { interruptedPartialInput } : {}),
                    });
                    return;
                }
                if (isTerminalShiftEnterSequence(character, state.getKeyboardMode())) {
                    insertTerminalInputText('\n', state);
                    continue;
                }
                if (character === '\n' || character === '\r') {
                    scheduleSubmit();
                    return;
                }
                if (character === '\b' || character === '\u007f') {
                    removeTerminalInputCharacter(state);
                    continue;
                }
                if (state.getBuffer().value.length >= maxChatPromptLength) {
                    output.write('\u0007');
                    continue;
                }
                insertTerminalInputText(character, state);
            }
        }

        input.on('data', onData);
    });
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
        output.write('\u0007');
        return;
    }
    const nextBuffer = insertTerminalChatInputText(state.getBuffer(), text);
    const nextState = createSlashCommandMenuState();
    state.setBuffer(nextBuffer);
    state.setMenuState(nextState);
    rerenderTerminalInputBlock(state);
}

function removeTerminalInputCharacter(state: TerminalReadState): void {
    const nextBuffer = deleteTerminalChatInputCharacterBeforeCursor(state.getBuffer());
    if (nextBuffer === state.getBuffer()) {
        return;
    }
    const nextState = createSlashCommandMenuState();
    state.setBuffer(nextBuffer);
    state.setMenuState(nextState);
    rerenderTerminalInputBlock(state);
}

function rerenderTerminalInputBlock(state: TerminalReadState): void {
    state.setRenderedBlock(
        renderTerminalInputBlock(
            output,
            state.getBuffer(),
            state.getMenuState(),
            state.getRenderedBlock(),
            state.getRenderContext(),
        ),
    );
}

function readTerminalCursorDirection(text: string): TerminalChatCursorDirection | undefined {
    if (text.includes('\u001b[D')) {
        return 'left';
    }
    if (text.includes('\u001b[C')) {
        return 'right';
    }
    if (text.includes('\u001b[A')) {
        return 'up';
    }
    if (text.includes('\u001b[B')) {
        return 'down';
    }
    return undefined;
}
