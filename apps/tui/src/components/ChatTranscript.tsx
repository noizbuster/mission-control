/** @jsxImportSource @opentui/solid */

import { blockPrefix, type ChatBlock, joinBlockText, readToolBlockTitle } from '@mission-control/tui/chat';
import { MacOSScrollAccel, type ScrollAcceleration, type ScrollBoxRenderable, TextAttributes } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/solid';
import { For, type JSX } from 'solid-js';
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
                    {...(props.streaming === true ? { streaming: true } : {})}
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

export function MessageBlockBase(props: MessageBlockProps): JSX.Element {
    const prefix = blockPrefix[props.block.kind];

    if (props.block.kind === 'system') {
        return (
            <box flexDirection="column">
                <For each={props.block.lines}>
                    {(line) => (
                        <text selectable attributes={TextAttributes.DIM}>
                            {line}
                        </text>
                    )}
                </For>
            </box>
        );
    }

    if (props.block.kind === 'tool') {
        const title = readToolBlockTitle(props.block.lines);
        return (
            <box marginTop={1}>
                <ToolCard
                    lines={props.block.lines}
                    expanded={props.toolOutputExpanded}
                    {...(title !== undefined ? { title } : {})}
                />
            </box>
        );
    }

    if (props.block.kind === 'thinking') {
        const joined = joinBlockText(props.block.lines, prefix);
        return (
            <MarkdownPanel
                text={joined}
                theme={thinkingTheme}
                barColor="#ff00ff"
                barWidth={2}
                marginTop={1}
                viewportColumns={props.viewportColumns}
                {...(props.isStreaming === true ? { streaming: true } : {})}
            />
        );
    }

    if (props.block.kind === 'assistant') {
        const joined = joinBlockText(props.block.lines, prefix);
        return (
            <MarkdownPanel
                text={joined}
                theme={darkTheme}
                barColor="#00ff00"
                barWidth={1}
                viewportColumns={props.viewportColumns}
                {...(props.isStreaming === true ? { streaming: true } : {})}
            />
        );
    }

    const leftHex = BLOCK_LEFT_HEX[props.block.kind];
    const isError = props.block.kind === 'error';
    return (
        <box flexDirection="row">
            {leftHex !== undefined ? <box width={1} backgroundColor={leftHex} shouldFill={true} /> : null}
            <box flexDirection="column" flexGrow={1} minWidth={0}>
                <For each={props.block.lines}>
                    {(line) => {
                        const content = prefix.length > 0 && line.startsWith(prefix) ? line.slice(prefix.length) : line;
                        return (
                            <text selectable {...(isError ? { fg: '#ff0000' } : {})}>
                                {content}
                            </text>
                        );
                    }}
                </For>
            </box>
        </box>
    );
}

export const MessageBlock = MessageBlockBase;

export function ChatTranscript(props: ChatTranscriptProps): JSX.Element {
    const dimensions = useTerminalDimensions();

    return (
        <scrollbox
            ref={(renderable: ScrollBoxRenderable) => props.scrollboxRef.set(renderable)}
            focusable={false}
            {...chatTranscriptScrollOptions()}
        >
            {props.blocks.length === 0 ? (
                <text attributes={TextAttributes.DIM}>{''}</text>
            ) : (
                <For each={props.blocks}>
                    {(block, index) => (
                        <MessageBlock
                            block={block}
                            toolOutputExpanded={props.toolOutputExpanded}
                            viewportColumns={dimensions().width}
                            {...(props.generating && index() === props.blocks.length - 1
                                ? { isStreaming: true }
                                : {})}
                        />
                    )}
                </For>
            )}
        </scrollbox>
    );
}
