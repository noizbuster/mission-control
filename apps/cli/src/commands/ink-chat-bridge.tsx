/**
 * Spike bridge between Ink's React component tree and the imperative chat loop.
 *
 * Architecture: `render(<ChatRoot />)` is called once inside `createInkChatBridge`.
 * Inside `ChatRoot`, `useInput` feeds keystrokes into `handleInput`, which mutates
 * the bridge core's input buffer and enqueues `ChatInputEvent`s. The imperative
 * `runInteractiveChatSession` loop `await`s events from `bridge.waitForEvent()`.
 *
 * The bridge core is the single source of truth for mutable state (input buffer,
 * output text, event queue, event waiters). `ChatRoot` subscribes to it via
 * `useSyncExternalStore` purely for rendering, so `useInput` always reads fresh
 * state from the core and never closes over a stale React snapshot.
 */

import { Box, type Key, render, Text, useInput } from 'ink';
import { useSyncExternalStore } from 'react';
import { SlashCommandMenu } from '../components/SlashCommandMenu.js';
import { StatusBar } from '../components/StatusBar.js';
import { TextInput } from '../components/TextInput.js';
import type { ChatInputEvent } from './interactive-chat-io.js';

type BridgeSnapshot = {
    readonly inputBuffer: string;
    readonly outputText: string;
};

/** Public surface consumed by the imperative chat loop. */
export type InkChatBridge = {
    readonly waitForEvent: () => Promise<ChatInputEvent>;
    readonly emitOutput: (text: string) => void;
    readonly getOutput: () => string;
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
    eventQueue: ChatInputEvent[];
    eventWaiters: Array<(event: ChatInputEvent) => void>;
    listeners: Set<() => void>;
    snapshot: BridgeSnapshot;
    unmountFn: (() => void) | undefined;
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

function publishSnapshot(core: InkChatBridgeCore): void {
    core.snapshot = { inputBuffer: core.inputBuffer, outputText: core.outputText };
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
    if (key.ctrl && input === 'c') {
        enqueueEvent(core, {
            type: 'interrupt',
            interruptedPartialInput: core.inputBuffer.length > 0,
        });
        return;
    }
    if (key.return) {
        enqueueEvent(core, { type: 'line', value: core.inputBuffer });
        core.inputBuffer = '';
        publishSnapshot(core);
        return;
    }
    if (key.backspace) {
        if (core.inputBuffer.length > 0) {
            core.inputBuffer = core.inputBuffer.slice(0, -1);
            publishSnapshot(core);
        }
        return;
    }
    if (input !== '' && !key.ctrl && !key.meta) {
        core.inputBuffer += input;
        publishSnapshot(core);
    }
}

function ChatRoot({ bridge, statusBarProps }: ChatRootProps) {
    const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
    useInput((input, key) => bridge.handleInput(input, key));

    const showSlashMenu = snapshot.inputBuffer.startsWith('/');
    const outputLines = snapshot.outputText.split('\n').filter((line) => line.length > 0);

    return (
        <Box flexDirection="column">
            {outputLines.map((line, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: terminal output is append-only, never reordered
                <Text key={`line-${index}`}>{line}</Text>
            ))}
            {showSlashMenu ? <SlashCommandMenu input={snapshot.inputBuffer} selectedIndex={0} commands={[]} /> : null}
            <TextInput value={snapshot.inputBuffer} onChange={() => {}} onSubmit={() => {}} prefix="" />
            {statusBarProps !== undefined ? <StatusBar {...statusBarProps} /> : null}
        </Box>
    );
}

/**
 * Mount the Ink tree once and return the imperative bridge. Callers `await`
 * `waitForEvent()` to consume `{ type: 'line' }` / `{ type: 'interrupt' }`
 * events, `emitOutput()` to append chat output, and `unmount()` to tear down.
 */
export function createInkChatBridge(options?: InkChatBridgeOptions): InkChatBridge {
    const core: InkChatBridgeCore = {
        inputBuffer: '',
        outputText: '',
        eventQueue: [],
        eventWaiters: [],
        listeners: new Set(),
        snapshot: { inputBuffer: '', outputText: '' },
        unmountFn: undefined,
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

    const unmount = (): void => {
        core.unmountFn?.();
    };

    return { waitForEvent, emitOutput, getOutput, unmount };
}
