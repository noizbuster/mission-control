import { createSlashCommandMenuState } from './interactive-chat-command-menu.js';
import { createTerminalChatInputBuffer } from './interactive-chat-input-block.js';
import {
    type TerminalKeyboardMode,
    terminalModifiedKeyDisableSequence,
    terminalModifiedKeyEnableSequence,
} from './interactive-chat-keyboard.js';
import { createTerminalInputParser } from './interactive-chat-terminal-input-parser.js';
import { interruptTokenEncodingFamily } from './interactive-chat-terminal-keys.js';
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
    readonly suspend?: () => void;
    readonly resume?: () => void;
    readonly controlsPrompt?: boolean;
    readonly renderPrompt?: (context?: ChatInputRenderContext) => void;
};

export type ChatOutput = {
    readonly write: (text: string) => void;
    readonly getOutput?: () => string;
    readonly setAgentStatus?: (text: string) => void;
    readonly clearAgentStatus?: () => void;
    readonly showApproval?: (toolName: string, action: string) => void;
    readonly hideApproval?: () => void;
};

type TerminalChatInputStreams = {
    readonly input: TerminalInputStream;
    readonly output: TerminalOutputStream;
};

type TerminalDataListener = (chunk: Buffer | string) => void;
type TerminalReadCancellation = () => void;

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
    let lastEmittedInterruptFamily: string | undefined;
    let suspended = false;
    const activeDataListeners = new Set<TerminalDataListener>();
    const activeReadCancellations = new Set<TerminalReadCancellation>();
    const keyboardMode = { modifiedKeysEnabled: true } satisfies TerminalKeyboardMode;
    const inputParser = createTerminalInputParser();
    streams.input.setRawMode(true);
    streams.input.resume();
    streams.output.write(terminalModifiedKeyEnableSequence);

    const input: TerminalInputStream = {
        get isRaw() {
            return streams.input.isRaw === true;
        },
        setRawMode: (isRaw) => {
            streams.input.setRawMode(isRaw);
        },
        resume: () => {
            streams.input.resume();
        },
        pause: () => {
            streams.input.pause();
        },
        on: (event, listener) => {
            activeDataListeners.add(listener);
            if (!suspended) {
                streams.input.on(event, listener);
            }
            return input;
        },
        off: (event, listener) => {
            activeDataListeners.delete(listener);
            streams.input.off(event, listener);
            return input;
        },
    };

    function resetLineState(): void {
        buffer = createTerminalChatInputBuffer();
        menuState = createSlashCommandMenuState();
        renderedBlock = emptyRenderedInputBlock;
        promptRendered = false;
    }

    function suspend(): void {
        if (closed || suspended) {
            return;
        }
        suspended = true;
        streams.output.write(terminalModifiedKeyDisableSequence);
        for (const listener of activeDataListeners) {
            streams.input.off('data', listener);
        }
    }

    function resume(): void {
        if (closed || !suspended) {
            return;
        }
        suspended = false;
        streams.input.setRawMode(true);
        streams.input.resume();
        streams.output.write(terminalModifiedKeyEnableSequence);
        for (const listener of activeDataListeners) {
            streams.input.on('data', listener);
        }
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
                shouldCoalesceInterruptToken: (token: string) => {
                    const family = interruptTokenEncodingFamily(token);
                    if (lastEmittedInterruptFamily !== undefined && family !== lastEmittedInterruptFamily) {
                        lastEmittedInterruptFamily = undefined;
                        return true;
                    }
                    lastEmittedInterruptFamily = family;
                    return false;
                },
                input,
                output: streams.output,
                resetLineState,
                registerCancel: (cancel) => {
                    activeReadCancellations.add(cancel);
                    return () => {
                        activeReadCancellations.delete(cancel);
                    };
                },
            });
        },
        suspend,
        resume,
        close: () => {
            if (closed) {
                return;
            }
            closed = true;
            for (const cancel of [...activeReadCancellations]) {
                cancel();
            }
            activeReadCancellations.clear();
            for (const listener of activeDataListeners) {
                streams.input.off('data', listener);
            }
            activeDataListeners.clear();
            streams.output.write(terminalModifiedKeyDisableSequence);
            streams.input.setRawMode(wasRaw);
            streams.input.pause();
        },
    };
}
