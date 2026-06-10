import { createSlashCommandMenuState } from './interactive-chat-command-menu.js';
import { createTerminalChatInputBuffer } from './interactive-chat-input-block.js';
import {
    type TerminalKeyboardMode,
    terminalModifiedKeyDisableSequence,
    terminalModifiedKeyEnableSequence,
} from './interactive-chat-keyboard.js';
import { createTerminalInputParser } from './interactive-chat-terminal-input-parser.js';
import {
    readTerminalChatEvent,
    type TerminalInputStream,
    type TerminalOutputStream,
} from './interactive-chat-terminal-read.js';
import {
    type ChatInputRenderContext,
    emptyRenderedInputBlock,
    renderTerminalInputBlock,
} from './interactive-chat-terminal-renderer.js';
import { stdin as processInput, stdout as processOutput } from 'node:process';

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

type TerminalChatInputStreams = {
    readonly input: TerminalInputStream;
    readonly output: TerminalOutputStream;
};

export const maxChatPromptLength = 8_000;

export function createTerminalChatOutput(): ChatOutput {
    return {
        write: (text: string) => {
            processOutput.write(text);
        },
    };
}

export function createTerminalChatInput(): ChatInput {
    return createTerminalChatInputFromStreams({ input: processInput, output: processOutput });
}

export function createTerminalChatInputFromStreams(streams: TerminalChatInputStreams): ChatInput {
    const wasRaw = streams.input.isRaw === true;
    let closed = false;
    let buffer = createTerminalChatInputBuffer();
    let menuState = createSlashCommandMenuState();
    let renderedBlock = emptyRenderedInputBlock;
    let promptRendered = false;
    let renderContext: ChatInputRenderContext | undefined;
    let lastInterruptTokenAtMs: number | undefined;
    const keyboardMode = { modifiedKeysEnabled: true } satisfies TerminalKeyboardMode;
    const inputParser = createTerminalInputParser();
    streams.input.setRawMode(true);
    streams.input.resume();
    streams.output.write(terminalModifiedKeyEnableSequence);

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
        renderedBlock = renderTerminalInputBlock(streams.output, buffer, menuState, renderedBlock, renderContext);
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
                readBufferedTokens: inputParser.takeBufferedTokens,
                pushBufferedTokens: inputParser.pushBufferedTokens,
                readTokens: inputParser.readTokens,
                shouldCoalesceInterruptToken: () => {
                    const now = Date.now();
                    const shouldCoalesce =
                        lastInterruptTokenAtMs !== undefined &&
                        now - lastInterruptTokenAtMs <= duplicateInterruptCoalescingWindowMs;
                    lastInterruptTokenAtMs = now;
                    return shouldCoalesce;
                },
                input: streams.input,
                output: streams.output,
                resetLineState,
            });
        },
        close: () => {
            if (closed) {
                return;
            }
            closed = true;
            streams.output.write(terminalModifiedKeyDisableSequence);
            streams.input.setRawMode(wasRaw);
            streams.input.pause();
        },
    };
}

const duplicateInterruptCoalescingWindowMs = 120;
