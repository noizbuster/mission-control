/**
 * Spike bridge between Ink's React component tree and the imperative chat loop.
 *
 * Architecture: `render(<ChatRoot />)` is called once inside `createInkChatBridge`.
 * Inside `ChatRoot`, `useInput` feeds keystrokes into `handleInput`, which mutates
 * the bridge core's input buffer and enqueues `ChatInputEvent`s. The imperative
 * `runInteractiveChatSession` loop `await`s events from `bridge.waitForEvent()`.
 *
 * The bridge core is the single source of truth for mutable state (input buffer,
 * output text, event queue, event waiters, slash command menu state, model picker
 * state). `ChatRoot` subscribes to it via `useSyncExternalStore` purely for
 * rendering, so `useInput` always reads fresh state from the core and never closes
 * over a stale React snapshot.
 *
 * Slash command autocomplete: when the input buffer starts with `/`, a filtered
 * command menu renders above the input. Arrow up/down navigates the selection,
 * and Enter resolves a partial match (e.g. `/ex` -> `/exit`) before submitting.
 *
 * Model picker overlay: when `/model` opens the picker, the bridge core switches
 * into `modelPickerActive` mode. `handleInput` routes all keystrokes to
 * `handleModelPickerInput`, which drives the shared `ProviderPromptKeypress`
 * reducer (the same state machine used by the terminal model selector and auth
 * provider prompts). ChatRoot renders the picker as a full overlay, replacing the
 * normal output/menu/input area until a selection is made or cancelled.
 */

import type { ModelProviderSelection } from '@mission-control/protocol';
import { Box, type Key, render, Text, useInput } from 'ink';
import { useSyncExternalStore, useState, useEffect } from 'react';
import { StatusBar } from '../components/StatusBar.js';
import {
    createProviderPromptKeypressState,
    createProviderPromptView,
    type ProviderPromptKeypressState,
    reduceProviderPromptKeypress,
} from './auth-provider-keypress.js';
import {
    createSlashCommandMenuState,
    createSlashCommandMenuView,
    reduceSlashCommandMenuSelection,
    resolveSlashCommandMenuSubmission,
    type SlashCommandMenuState,
} from './interactive-chat-command-menu.js';
import {
    createChatInputHistory,
    isNavigatingChatInputHistory,
    navigateChatInputHistoryDown,
    navigateChatInputHistoryUp,
    recordSubmittedPrompt,
    type ChatInputHistory,
} from './interactive-chat-input-history.js';
import type { ChatInputEvent } from './interactive-chat-io.js';
import type { ModelChoice } from './interactive-chat-model.js';

type BridgeSnapshot = {
    readonly inputBuffer: string;
    readonly outputText: string;
    readonly menuState: SlashCommandMenuState;
    readonly modelPickerActive: boolean;
    readonly modelPickerChoices: readonly ModelChoice[];
    readonly modelPickerKeypress: ProviderPromptKeypressState;
    readonly generating: boolean;
    readonly agentStatusText: string;
    readonly historyNavigation: { readonly position: number; readonly total: number } | null;
};

/** Public surface consumed by the imperative chat loop. */
export type InkChatBridge = {
    readonly waitForEvent: () => Promise<ChatInputEvent>;
    readonly emitOutput: (text: string) => void;
    readonly getOutput: () => string;
    readonly showModelPicker: (choices: readonly ModelChoice[]) => Promise<ModelProviderSelection | undefined>;
    readonly setGenerating: (value: boolean) => void;
    readonly setAgentStatus: (text: string) => void;
    readonly clearAgentStatus: () => void;
    readonly unmount: () => void;
};

/** Provider/model/session info passed through to the StatusBar render surface. */
export type InkChatBridgeOptions = {
    readonly providerID: string;
    readonly modelID: string;
    readonly variantID?: string;
    readonly sessionID?: string;
};

type InkChatBridgeCore = {
    inputBuffer: string;
    outputText: string;
    menuState: SlashCommandMenuState;
    eventQueue: ChatInputEvent[];
    eventWaiters: Array<(event: ChatInputEvent) => void>;
    listeners: Set<() => void>;
    snapshot: BridgeSnapshot;
    unmountFn: (() => void) | undefined;
    modelPickerChoices: readonly ModelChoice[];
    modelPickerKeypress: ProviderPromptKeypressState;
    modelPickerActive: boolean;
    modelPickerResolve: ((selection: ModelProviderSelection | undefined) => void) | undefined;
    generating: boolean;
    agentStatusText: string;
    history: ChatInputHistory;
};

/** Minimal props the React tree uses to talk to the bridge core. */
type ChatRootProps = {
    readonly bridge: {
        readonly subscribe: (listener: () => void) => () => void;
        readonly getSnapshot: () => BridgeSnapshot;
        readonly handleInput: (input: string, key: Key) => void;
    };
    readonly statusBarProps?: InkChatBridgeOptions;
};

const slashMenuMaxVisibleChoices = 5;
const modelPickerMaxVisibleChoices = 10;

function publishSnapshot(core: InkChatBridgeCore): void {
    const historyNavigation = isNavigatingChatInputHistory(core.history)
        ? { position: core.history.cursor + 1, total: core.history.entries.length }
        : null;
    core.snapshot = {
        inputBuffer: core.inputBuffer,
        outputText: core.outputText,
        menuState: core.menuState,
        modelPickerActive: core.modelPickerActive,
        modelPickerChoices: core.modelPickerChoices,
        modelPickerKeypress: core.modelPickerKeypress,
        generating: core.generating,
        agentStatusText: core.agentStatusText,
        historyNavigation,
    };
    for (const listener of core.listeners) {
        listener();
    }
}

function enqueueEvent(core: InkChatBridgeCore, event: ChatInputEvent): void {
    const waiter = core.eventWaiters.shift();
    if (waiter !== undefined) {
        waiter(event);
        return;
    }
    core.eventQueue.push(event);
}

function handleInput(core: InkChatBridgeCore, input: string, key: Key): void {
    if (core.modelPickerActive) {
        handleModelPickerInput(core, input, key);
        return;
    }
    if (key.ctrl && input === 'c') {
        enqueueEvent(core, {
            type: 'interrupt',
            interruptedPartialInput: core.inputBuffer.length > 0,
        });
        return;
    }
    if (key.upArrow) {
        if (core.inputBuffer.startsWith('/')) {
            core.menuState = reduceSlashCommandMenuSelection(core.menuState, '\u001b[A', core.inputBuffer);
        } else {
            const result = navigateChatInputHistoryUp(core.history, core.inputBuffer);
            core.history = result.history;
            core.inputBuffer = result.input;
            core.menuState = createSlashCommandMenuState();
        }
        publishSnapshot(core);
        return;
    }
    if (key.downArrow) {
        if (core.inputBuffer.startsWith('/')) {
            core.menuState = reduceSlashCommandMenuSelection(core.menuState, '\u001b[B', core.inputBuffer);
        } else {
            const result = navigateChatInputHistoryDown(core.history, core.inputBuffer);
            core.history = result.history;
            core.inputBuffer = result.input;
            core.menuState = createSlashCommandMenuState();
        }
        publishSnapshot(core);
        return;
    }
    if (key.return || input.includes('\r') || input.includes('\n')) {
        const textBeforeReturn = input.split(/[\r\n]/)[0] ?? '';
        if (textBeforeReturn.length > 0 && !key.ctrl && !key.meta) {
            core.inputBuffer += textBeforeReturn;
            core.menuState = createSlashCommandMenuState();
        }
        let value = core.inputBuffer;
        if (core.inputBuffer.startsWith('/')) {
            const resolved = resolveSlashCommandMenuSubmission(core.inputBuffer, core.menuState);
            if (resolved !== core.inputBuffer) {
                value = resolved;
            }
        }
        enqueueEvent(core, { type: 'line', value });
        core.inputBuffer = '';
        core.menuState = createSlashCommandMenuState();
        core.history = recordSubmittedPrompt(core.history, value);
        if (!value.startsWith('/')) {
            core.outputText += `You: ${value}\n`;
        }
        publishSnapshot(core);
        return;
    }
    if (key.backspace) {
        if (core.inputBuffer.length > 0) {
            core.inputBuffer = core.inputBuffer.slice(0, -1);
            core.menuState = createSlashCommandMenuState();
            publishSnapshot(core);
        }
        return;
    }
    if (input !== '' && !key.ctrl && !key.meta) {
        core.inputBuffer += input;
        core.menuState = createSlashCommandMenuState();
        publishSnapshot(core);
    }
}

function handleModelPickerInput(core: InkChatBridgeCore, input: string, key: Key): void {
    if (key.ctrl && input === 'c') {
        core.modelPickerActive = false;
        core.modelPickerResolve?.(undefined);
        core.modelPickerResolve = undefined;
        publishSnapshot(core);
        return;
    }
    if (key.return || input.includes('\r') || input.includes('\n')) {
        const promptChoices = core.modelPickerChoices.map((choice) => ({
            id: choice.id,
            name: choice.label,
        }));
        const view = createProviderPromptView(core.modelPickerKeypress, promptChoices, modelPickerMaxVisibleChoices);
        const selected = core.modelPickerChoices.find(
            (choice) => choice.id === view.filteredChoices[view.selectedIndex]?.id,
        );
        core.modelPickerActive = false;
        core.modelPickerResolve?.(selected?.selection);
        core.modelPickerResolve = undefined;
        publishSnapshot(core);
        return;
    }
    let rawInput = input;
    if (key.upArrow) {
        rawInput = '\u001b[A';
    } else if (key.downArrow) {
        rawInput = '\u001b[B';
    }
    const promptChoices = core.modelPickerChoices.map((choice) => ({
        id: choice.id,
        name: choice.label,
    }));
    core.modelPickerKeypress = reduceProviderPromptKeypress(core.modelPickerKeypress, rawInput, promptChoices);
    publishSnapshot(core);
}

const SPINNER_FRAMES = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'] as const;
const SPINNER_INTERVAL_MS = 80;

function AgentSpinner({ text }: { readonly text: string }): React.ReactElement {
    const [frame, setFrame] = useState(0);
    useEffect(() => {
        const timer = setInterval(() => {
            setFrame((current) => (current + 1) % SPINNER_FRAMES.length);
        }, SPINNER_INTERVAL_MS);
        return () => {
            clearInterval(timer);
        };
    }, []);
    return (
        <Box marginTop={1}>
            <Text color="yellow">{SPINNER_FRAMES[frame]} </Text>
            <Text dimColor>{text}</Text>
        </Box>
    );
}

function ChatRoot({ bridge, statusBarProps }: ChatRootProps) {
    const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
    useInput((input, key) => bridge.handleInput(input, key));

    if (snapshot.modelPickerActive) {
        const promptChoices = snapshot.modelPickerChoices.map((choice) => ({
            id: choice.id,
            name: choice.label,
        }));
        const view = createProviderPromptView(
            snapshot.modelPickerKeypress,
            promptChoices,
            modelPickerMaxVisibleChoices,
        );
        return (
            <Box flexDirection="column">
                <Text bold color="cyan">
                    Select model
                </Text>
                <Text dimColor>{`Search: ${view.searchQuery}`}</Text>
                {view.totalCount === 0 ? (
                    <Text dimColor>No models match</Text>
                ) : (
                    <Text dimColor>{`Showing ${view.startIndex + 1}-${view.endIndex} of ${view.totalCount}`}</Text>
                )}
                {view.visibleChoices.map((choice, index) => {
                    const globalIndex = view.startIndex + index;
                    const isSelected = globalIndex === view.selectedIndex;
                    return (
                        <Text key={choice.id} {...(isSelected ? { backgroundColor: 'blue' } : {})}>
                            {isSelected ? '> ' : '  '}
                            {globalIndex + 1}. {choice.name}
                        </Text>
                    );
                })}
                <Text dimColor>Use Up/Down, type to search, Enter to select, Ctrl+C to cancel</Text>
            </Box>
        );
    }

    const showSlashMenu = snapshot.inputBuffer.startsWith('/');
    const menuView = showSlashMenu
        ? createSlashCommandMenuView(snapshot.inputBuffer, snapshot.menuState, slashMenuMaxVisibleChoices)
        : null;
    const messageBlocks = parseMessageBlocks(snapshot.outputText);

    return (
        <Box flexDirection="column">
            {messageBlocks.map((block, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: chat blocks are append-only
                <MessageBlock key={`msg-${block.kind}-${index}`} block={block} />
            ))}
            {snapshot.agentStatusText.length > 0 ? (
                <AgentSpinner text={snapshot.agentStatusText} />
            ) : snapshot.generating ? (
                <Box marginTop={1}>
                    <Text color="yellow">{'\u25CF Thinking...'}</Text>
                </Box>
            ) : null}
            {menuView !== null && menuView.open ? (
                <Box flexDirection="column" marginTop={1}>
                    {menuView.empty ? (
                        <Text dimColor> no commands match</Text>
                    ) : (
                        menuView.visibleChoices.map((choice, index) => {
                            const globalIndex = menuView.startIndex + index;
                            const isSelected = globalIndex === menuView.selectedIndex;
                            return (
                                <Text key={choice.id} {...(isSelected ? { backgroundColor: 'blue' } : {})}>
                                    {isSelected ? '> ' : '  '}
                                    {choice.id.padEnd(13)} {choice.description}
                                </Text>
                            );
                        })
                    )}
                </Box>
            ) : null}
            <Box flexDirection="column" marginTop={1}>
                <Text dimColor>{'─'.repeat(process.stdout.columns ?? 80)}</Text>
                <Text>
                    <Text color="cyan">{'>'}</Text> {snapshot.inputBuffer}
                    {snapshot.historyNavigation !== null ? (
                        <Text dimColor>
                            {' '}
                            {`[history ${snapshot.historyNavigation.position}/${snapshot.historyNavigation.total} — ↑/↓ to recall, Enter to use]`}
                        </Text>
                    ) : snapshot.inputBuffer.length === 0 ? (
                        <Text dimColor> Type a message or / for commands</Text>
                    ) : null}
                </Text>
            </Box>
            {statusBarProps !== undefined ? (
                <Box marginTop={1}>
                    <StatusBar {...statusBarProps} />
                </Box>
            ) : null}
        </Box>
    );
}

/**
 * Mount the Ink tree once and return the imperative bridge. Callers `await`
 * `waitForEvent()` to consume `{ type: 'line' }` / `{ type: 'interrupt' }`
 * events, `emitOutput()` to append chat output, `showModelPicker()` to open the
 * `/model` selection overlay, and `unmount()` to tear down.
 */
export function createInkChatBridge(options?: InkChatBridgeOptions): InkChatBridge {
    const core: InkChatBridgeCore = {
        inputBuffer: '',
        outputText: '',
        menuState: createSlashCommandMenuState(),
        eventQueue: [],
        eventWaiters: [],
        listeners: new Set(),
        snapshot: {
            inputBuffer: '',
            outputText: '',
            menuState: createSlashCommandMenuState(),
            modelPickerActive: false,
            modelPickerChoices: [],
            modelPickerKeypress: createProviderPromptKeypressState(),
        generating: false,
        agentStatusText: '',
        historyNavigation: null,
        },
        unmountFn: undefined,
        modelPickerChoices: [],
        modelPickerKeypress: createProviderPromptKeypressState(),
        modelPickerActive: false,
        modelPickerResolve: undefined,
        generating: false,
        agentStatusText: '',
        history: createChatInputHistory(),
    };

    const subscribe = (listener: () => void): (() => void) => {
        core.listeners.add(listener);
        return () => {
            core.listeners.delete(listener);
        };
    };

    const getSnapshot = (): BridgeSnapshot => core.snapshot;

    const internalBridge: ChatRootProps['bridge'] = {
        subscribe,
        getSnapshot,
        handleInput: (input, key) => handleInput(core, input, key),
    };

    const instance = render(
        <ChatRoot bridge={internalBridge} {...(options !== undefined ? { statusBarProps: options } : {})} />,
        { exitOnCtrlC: false },
    );
    core.unmountFn = instance.unmount;

    const waitForEvent = (): Promise<ChatInputEvent> => {
        const queued = core.eventQueue.shift();
        if (queued !== undefined) {
            return Promise.resolve(queued);
        }
        return new Promise<ChatInputEvent>((resolve) => {
            core.eventWaiters.push(resolve);
        });
    };

    const emitOutput = (text: string): void => {
        core.outputText += text;
        publishSnapshot(core);
    };

    const getOutput = (): string => core.outputText;

    const showModelPicker = (choices: readonly ModelChoice[]): Promise<ModelProviderSelection | undefined> => {
        if (choices.length === 0) {
            return Promise.resolve(undefined);
        }
        core.modelPickerChoices = choices;
        core.modelPickerKeypress = createProviderPromptKeypressState();
        core.modelPickerActive = true;
        publishSnapshot(core);
        return new Promise<ModelProviderSelection | undefined>((resolve) => {
            core.modelPickerResolve = resolve;
        });
    };

    const setGenerating = (value: boolean): void => {
        core.generating = value;
        publishSnapshot(core);
    };

    const setAgentStatus = (text: string): void => {
        core.agentStatusText = text;
        publishSnapshot(core);
    };

    const clearAgentStatus = (): void => {
        core.agentStatusText = '';
        publishSnapshot(core);
    };

    const unmount = (): void => {
        core.unmountFn?.();
    };

    return { waitForEvent, emitOutput, getOutput, showModelPicker, setGenerating, setAgentStatus, clearAgentStatus, unmount };
}

type ChatBlock = {
    readonly kind: 'user' | 'assistant' | 'error' | 'system';
    readonly lines: readonly string[];
};

function parseMessageBlocks(outputText: string): readonly ChatBlock[] {
    const rawLines = outputText.split('\n').filter((line) => line.length > 0);
    const blocks: ChatBlock[] = [];
    let currentKind: ChatBlock['kind'] | undefined;
    let currentLines: string[] = [];

    const flush = (): void => {
        if (currentKind !== undefined && currentLines.length > 0) {
            blocks.push({ kind: currentKind, lines: currentLines });
        }
        currentKind = undefined;
        currentLines = [];
    };

    for (const line of rawLines) {
        let kind: ChatBlock['kind'];
        if (line.startsWith('You: ')) {
            kind = 'user';
        } else if (line.startsWith('Assistant: ')) {
            kind = 'assistant';
        } else if (line.startsWith('Error: ')) {
            kind = 'error';
        } else {
            kind = 'system';
        }
        if (kind !== currentKind) {
            flush();
            currentKind = kind;
        }
        currentLines.push(line);
    }
    flush();
    return blocks;
}

const blockLeftColor: Record<ChatBlock['kind'], string | undefined> = {
    user: 'cyan',
    assistant: 'green',
    error: 'red',
    system: undefined,
};

const blockPrefix: Record<ChatBlock['kind'], string> = {
    user: 'You: ',
    assistant: 'Assistant: ',
    error: 'Error: ',
    system: '',
};

function MessageBlock({ block }: { readonly block: ChatBlock }): React.ReactElement {
    const leftColor = blockLeftColor[block.kind];
    const prefix = blockPrefix[block.kind];
    const showBlock = block.kind !== 'system';

    if (!showBlock) {
        return (
            <Box flexDirection="column">
                {block.lines.map((line, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: chat blocks are append-only
                    <Text key={`sys-${index}`} dimColor>
                        {line}
                    </Text>
                ))}
            </Box>
        );
    }

    return (
        <Box flexDirection="row">
            {leftColor !== undefined ? (
                <Box width={1} flexDirection="column">
                    {block.lines.map((_line, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: chat blocks are append-only
                        <Text key={`bar-${index}`} backgroundColor={leftColor}>
                            {' '}
                        </Text>
                    ))}
                </Box>
            ) : null}
            <Box flexDirection="column" flexGrow={1}>
                {block.lines.map((line, index) => {
                    const content = prefix.length > 0 && line.startsWith(prefix) ? line.slice(prefix.length) : line;
                    const isError = block.kind === 'error';
                    return (
                        <Text
                            // biome-ignore lint/suspicious/noArrayIndexKey: chat blocks are append-only
                            key={`line-${index}`}
                            {...(isError ? { color: 'red' } : {})}
                            {...(block.kind === 'assistant' ? { dimColor: true } : {})}
                        >
                            {content}
                        </Text>
                    );
                })}
            </Box>
        </Box>
    );
}
