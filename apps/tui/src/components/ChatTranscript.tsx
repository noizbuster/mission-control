/** @jsxImportSource @opentui/solid */

import { blockPrefix, type ChatBlock, joinBlockText, readToolBlockTitle } from '@mission-control/tui/chat';
import { MacOSScrollAccel, type ScrollAcceleration, type ScrollBoxRenderable, TextAttributes } from '@opentui/core';
import { For, type JSX } from 'solid-js';
import { Markdown } from './markdown/Markdown.js';
import { darkTheme, type TerminalMarkdownTheme } from './markdown/theme.js';
import { ToolCard } from './ToolCard.js';

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
    readonly width: '100%';
    readonly maxHeight?: number;
};

export function chatTranscriptScrollOptions(maxHeight?: number): ChatTranscriptScrollOptions {
    return {
        stickyScroll: true,
        stickyStart: 'bottom',
        scrollAcceleration: new MacOSScrollAccel(),
        flexGrow: 1,
        width: '100%',
        ...(maxHeight !== undefined ? { maxHeight } : {}),
    };
}

export type ChatTranscriptProps = {
    readonly blocks: readonly ChatBlock[];
    readonly scrollboxRef: ChatScrollboxHandle;
    readonly generating: boolean;
    readonly toolOutputExpanded: boolean;
    readonly viewportColumns: number;
};

export type ChatTranscriptScrollboxProps = {
    readonly children?: JSX.Element;
    readonly scrollboxRef: ChatScrollboxHandle;
    readonly maxHeight?: number;
};

export function ChatTranscriptScrollbox({
    children,
    scrollboxRef,
    maxHeight,
}: ChatTranscriptScrollboxProps): JSX.Element {
    return (
        <scrollbox
            ref={(renderable: ScrollBoxRenderable) => scrollboxRef.set(renderable)}
            {...chatTranscriptScrollOptions(maxHeight)}
        >
            {children}
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

export function MarkdownPanelBase({
    text,
    theme,
    barColor,
    barWidth,
    streaming,
    marginTop,
    viewportColumns,
}: {
    readonly text: string;
    readonly theme: TerminalMarkdownTheme;
    readonly barColor: string;
    readonly barWidth: number;
    readonly streaming?: boolean;
    readonly marginTop?: number;
    readonly viewportColumns: number;
}): JSX.Element {
    return (
        <box flexDirection="row" {...(marginTop !== undefined ? { marginTop } : {})}>
            <box width={barWidth} backgroundColor={barColor} shouldFill={true} />
            <box flexDirection="column" flexGrow={1}>
                <Markdown
                    text={text}
                    theme={theme}
                    width={viewportColumns}
                    {...(streaming ? { streaming: true } : {})}
                />
            </box>
        </box>
    );
}

export const MarkdownPanel = MarkdownPanelBase;

export function MessageBlockBase({
    block,
    isStreaming,
    toolOutputExpanded,
    viewportColumns,
}: {
    readonly block: ChatBlock;
    readonly isStreaming?: boolean;
    readonly toolOutputExpanded: boolean;
    readonly viewportColumns: number;
}): JSX.Element {
    const prefix = blockPrefix[block.kind];

    if (block.kind === 'system') {
        return (
            <box flexDirection="column">
                <For each={block.lines}>
                    {(line) => (
                        <text selectable attributes={TextAttributes.DIM}>
                            {line}
                        </text>
                    )}
                </For>
            </box>
        );
    }

    if (block.kind === 'tool') {
        const title = readToolBlockTitle(block.lines);
        return (
            <box marginTop={1}>
                <ToolCard
                    lines={block.lines}
                    expanded={toolOutputExpanded}
                    {...(title !== undefined ? { title } : {})}
                />
            </box>
        );
    }

    if (block.kind === 'thinking') {
        const joined = joinBlockText(block.lines, prefix);
        return (
            <MarkdownPanel
                text={joined}
                theme={thinkingTheme}
                barColor="#ff00ff"
                barWidth={2}
                marginTop={1}
                viewportColumns={viewportColumns}
                {...(isStreaming ? { streaming: true } : {})}
            />
        );
    }

    if (block.kind === 'assistant') {
        const joined = joinBlockText(block.lines, prefix);
        return (
            <MarkdownPanel
                text={joined}
                theme={darkTheme}
                barColor="#00ff00"
                barWidth={1}
                viewportColumns={viewportColumns}
                {...(isStreaming ? { streaming: true } : {})}
            />
        );
    }

    const leftHex = BLOCK_LEFT_HEX[block.kind];
    const isError = block.kind === 'error';
    return (
        <box flexDirection="row">
            {leftHex !== undefined ? <box width={1} backgroundColor={leftHex} shouldFill={true} /> : null}
            <box flexDirection="column" flexGrow={1}>
                <For each={block.lines}>
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

export function ChatTranscript({
    blocks,
    scrollboxRef,
    generating,
    toolOutputExpanded,
    viewportColumns,
}: ChatTranscriptProps): JSX.Element {
    if (blocks.length === 0) {
        return (
            <scrollbox
                ref={(renderable: ScrollBoxRenderable) => scrollboxRef.set(renderable)}
                focusable={false}
                {...chatTranscriptScrollOptions()}
            >
                <text attributes={TextAttributes.DIM}>{''}</text>
            </scrollbox>
        );
    }
    const lastIndex = blocks.length - 1;
    return (
        <scrollbox
            ref={(renderable: ScrollBoxRenderable) => scrollboxRef.set(renderable)}
            focusable={false}
            {...chatTranscriptScrollOptions()}
        >
            <For each={blocks}>
                {(block, index) => {
                    const streaming = generating && index() === lastIndex;
                    return (
                        <MessageBlock
                            block={block}
                            toolOutputExpanded={toolOutputExpanded}
                            viewportColumns={viewportColumns}
                            {...(streaming ? { isStreaming: true } : {})}
                        />
                    );
                }}
            </For>
        </scrollbox>
    );
}
