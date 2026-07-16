/** @jsxImportSource @opentui/solid */

import { blockPrefix, type ChatBlock, joinBlockText, readToolBlockTitle } from '@mission-control/tui/chat';
import { MacOSScrollAccel, type ScrollAcceleration, type ScrollBoxRenderable, TextAttributes } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/solid';
import { For, Index, Match, Show, Switch, type JSX } from 'solid-js';
import { darkTheme } from './markdown/interactive-theme';
import { Markdown } from './markdown/Markdown';
import type { TerminalMarkdownTheme } from './markdown/theme';
import { ToolCard } from './ToolCard';

export interface ChatScrollboxHandle {
    readonly get: () => ChatScrollboxSurface | undefined;
    readonly set: (renderable: ScrollBoxRenderable) => void;
}

type ChatScrollTarget = number | { readonly x?: number; readonly y?: number };

export interface ChatScrollboxSurface {
    readonly scrollHeight: number;
    scrollTo(target: ChatScrollTarget): void;
    scrollBy(delta: ChatScrollTarget): void;
}

export type ChatTranscriptScrollOptions = {
    readonly stickyScroll: true;
    readonly stickyStart: 'bottom';
    readonly scrollAcceleration: ScrollAcceleration;
    readonly flexGrow: 1;
    readonly minHeight: 0;
    readonly maxHeight?: number;
};

export function chatTranscriptScrollOptions(maxHeight?: number): ChatTranscriptScrollOptions {
    return {
        stickyScroll: true,
        stickyStart: 'bottom',
        scrollAcceleration: new MacOSScrollAccel(),
        flexGrow: 1,
        minHeight: 0,
        ...(maxHeight !== undefined ? { maxHeight } : {}),
    };
}

export type ChatTranscriptProps = {
    readonly blocks: readonly ChatBlock[];
    readonly scrollboxRef: ChatScrollboxHandle;
    readonly generating: boolean;
    readonly toolOutputExpanded: boolean;
};

export type ChatTranscriptScrollboxProps = {
    readonly children?: JSX.Element;
    readonly scrollboxRef: ChatScrollboxHandle;
    readonly maxHeight?: number;
};

export function ChatTranscriptScrollbox(props: ChatTranscriptScrollboxProps): JSX.Element {
    return (
        <scrollbox
            ref={(renderable: ScrollBoxRenderable) => props.scrollboxRef.set(renderable)}
            {...chatTranscriptScrollOptions(props.maxHeight)}
        >
            {props.children}
        </scrollbox>
    );
}

const BLOCK_LEFT_HEX: Record<ChatBlock['kind'], string | undefined> = {
    user: '#00ffff',
    assistant: '#00ff00',
    error: '#ff0000',
    system: undefined,
    tool: '#ffff00',
    thinking: '#ff00ff',
};

const thinkingTheme: TerminalMarkdownTheme = {
    ...darkTheme,
    defaultTextStyle: { attributes: { italic: true, dim: true } },
};

export type MarkdownPanelProps = {
    readonly text: string;
    readonly theme: TerminalMarkdownTheme;
    readonly barColor: string;
    readonly barWidth: number;
    readonly streaming?: boolean;
    readonly marginTop?: number;
    readonly viewportColumns: number;
};

export function MarkdownPanelBase(props: MarkdownPanelProps): JSX.Element {
    return (
        <box flexDirection="row" {...(props.marginTop !== undefined ? { marginTop: props.marginTop } : {})}>
            <box width={props.barWidth} backgroundColor={props.barColor} shouldFill={true} flexShrink={0} />
            <box flexDirection="column" flexGrow={1} minWidth={0}>
                <Markdown
                    text={props.text}
                    theme={props.theme}
                    width={Math.max(1, props.viewportColumns - props.barWidth)}
                    streaming={props.streaming === true}
                />
            </box>
        </box>
    );
}

export const MarkdownPanel = MarkdownPanelBase;

export type MessageBlockProps = {
    readonly block: ChatBlock;
    readonly isStreaming?: boolean;
    readonly toolOutputExpanded: boolean;
    readonly viewportColumns: number;
};

/**
 * Fully reactive block renderer. Must not freeze `props.block` into consts at
 * mount time: streaming updates the last block in place (Solid `Index` keeps the
 * component mounted), and native `<markdown streaming>` needs content prop
 * updates without remounting the whole panel.
 */
export function MessageBlockBase(props: MessageBlockProps): JSX.Element {
    const kind = () => props.block.kind;
    const lines = () => props.block.lines;
    const prefix = () => blockPrefix[kind()];
    const joined = () => joinBlockText(lines(), prefix());
    const streaming = () => props.isStreaming === true;
    const toolTitle = () => readToolBlockTitle(lines());
    const leftHex = () => BLOCK_LEFT_HEX[kind()];
    const isError = () => kind() === 'error';

    return (
        <Switch>
            <Match when={kind() === 'system'}>
                <box flexDirection="column">
                    <For each={lines()}>
                        {(line) => (
                            <text selectable attributes={TextAttributes.DIM}>
                                {line}
                            </text>
                        )}
                    </For>
                </box>
            </Match>
            <Match when={kind() === 'tool'}>
                <box marginTop={1}>
                    <ToolCard
                        lines={lines()}
                        expanded={props.toolOutputExpanded}
                        {...(toolTitle() !== undefined ? { title: toolTitle() } : {})}
                    />
                </box>
            </Match>
            <Match when={kind() === 'thinking'}>
                <MarkdownPanel
                    text={joined()}
                    theme={thinkingTheme}
                    barColor="#ff00ff"
                    barWidth={2}
                    marginTop={1}
                    viewportColumns={props.viewportColumns}
                    streaming={streaming()}
                />
            </Match>
            <Match when={kind() === 'assistant'}>
                <MarkdownPanel
                    text={joined()}
                    theme={darkTheme}
                    barColor="#00ff00"
                    barWidth={1}
                    viewportColumns={props.viewportColumns}
                    streaming={streaming()}
                />
            </Match>
            <Match when={kind() === 'user' || kind() === 'error'}>
                <box flexDirection="row">
                    <Show when={leftHex() !== undefined}>
                        <box width={1} backgroundColor={leftHex()} shouldFill={true} />
                    </Show>
                    <box flexDirection="column" flexGrow={1} minWidth={0}>
                        <For each={lines()}>
                            {(line) => {
                                const content = () => {
                                    const p = prefix();
                                    return p.length > 0 && line.startsWith(p) ? line.slice(p.length) : line;
                                };
                                return (
                                    <text selectable {...(isError() ? { fg: '#ff0000' } : {})}>
                                        {content()}
                                    </text>
                                );
                            }}
                        </For>
                    </box>
                </box>
            </Match>
        </Switch>
    );
}

export const MessageBlock = MessageBlockBase;

/**
 * Transcript list uses Solid `Index` (by position), not `For` (by referential
 * identity). Streaming rewrites the last block every coalesce tick; `For` would
 * destroy and remount that MessageBlock (and its native markdown) on every
 * chunk, which paints as full-panel flicker. `Index` keeps the row mounted and
 * only updates reactive props into the streaming markdown renderable.
 */
export function ChatTranscript(props: ChatTranscriptProps): JSX.Element {
    const dimensions = useTerminalDimensions();

    return (
        <scrollbox
            ref={(renderable: ScrollBoxRenderable) => props.scrollboxRef.set(renderable)}
            focusable={false}
            {...chatTranscriptScrollOptions()}
        >
            <Show when={props.blocks.length > 0} fallback={<text attributes={TextAttributes.DIM}>{''}</text>}>
                <Index each={props.blocks}>
                    {(block, index) => (
                        <MessageBlock
                            block={block()}
                            toolOutputExpanded={props.toolOutputExpanded}
                            viewportColumns={dimensions().width}
                            isStreaming={props.generating && index === props.blocks.length - 1}
                        />
                    )}
                </Index>
            </Show>
        </scrollbox>
    );
}
