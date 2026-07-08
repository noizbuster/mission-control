/** @jsxImportSource @opentui/react */
import { MacOSScrollAccel, type ScrollAcceleration, type ScrollBoxRenderable, TextAttributes } from '@opentui/core';
import type * as React from 'react';
import { memo } from 'react';
import { blockPrefix, type ChatBlock, joinBlockText, readToolBlockTitle } from '../commands/chat-blocks.js';
import { Markdown } from './markdown/Markdown.js';
import { darkTheme, type TerminalMarkdownTheme } from './markdown/theme.js';
import { ToolCard } from './ToolCard.js';

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
    readonly scrollboxRef: React.RefObject<ScrollBoxRenderable | null>;
    readonly generating: boolean;
    readonly toolOutputExpanded: boolean;
    readonly viewportColumns: number;
};

export type ChatTranscriptScrollboxProps = {
    readonly children?: React.ReactNode;
    readonly scrollboxRef: React.RefObject<ScrollBoxRenderable | null>;
    readonly maxHeight?: number;
};

export function ChatTranscriptScrollbox({
    children,
    scrollboxRef,
    maxHeight,
}: ChatTranscriptScrollboxProps): React.ReactNode {
    return (
        <scrollbox ref={scrollboxRef} {...chatTranscriptScrollOptions(maxHeight)}>
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
}): React.ReactNode {
    return (
        <box flexDirection="row" {...(marginTop !== undefined ? { marginTop } : {})}>
            <box width={barWidth} backgroundColor={barColor} shouldFill={true} />
            <box flexDirection="column" flexGrow={1}>
                <Markdown
                    key={viewportColumns}
                    text={text}
                    theme={theme}
                    {...(streaming ? { streaming: true } : {})}
                />
            </box>
        </box>
    );
}

/**
 * Memoized wrapper: skips re-render when all props are unchanged (shallow
 * compare). Effective because MessageBlock passes a value-stable `text`
 * (pure joinBlockText of a referentially-stable block.lines, per todo 2's
 * preserveBlockReferences) plus module-constant theme/barColor/barWidth.
 */
export const MarkdownPanel = memo(MarkdownPanelBase);

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
}): React.ReactNode {
    const prefix = blockPrefix[block.kind];

    if (block.kind === 'system') {
        return (
            <box flexDirection="column">
                {block.lines.map((line, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: chat blocks are append-only
                    <text key={`sys-${index}`} selectable attributes={TextAttributes.DIM}>
                        {line}
                    </text>
                ))}
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
                {block.lines.map((line, index) => {
                    const content = prefix.length > 0 && line.startsWith(prefix) ? line.slice(prefix.length) : line;
                    return (
                        <text
                            selectable
                            // biome-ignore lint/suspicious/noArrayIndexKey: chat blocks are append-only
                            key={`line-${index}`}
                            {...(isError ? { fg: '#ff0000' } : {})}
                        >
                            {content}
                        </text>
                    );
                })}
            </box>
        </box>
    );
}

/**
 * Memoized wrapper: skips re-render when all props are unchanged (shallow
 * compare). Effective because ChatTranscript passes a referentially-stable
 * `block` (preserveBlockReferences in ChatApp reuses refs for unchanged
 * segments), so completed blocks skip re-render while the streaming tail
 * (whose block ref changes per token) re-renders normally.
 */
export const MessageBlock = memo(MessageBlockBase);

export function ChatTranscript({
    blocks,
    scrollboxRef,
    generating,
    toolOutputExpanded,
    viewportColumns,
}: ChatTranscriptProps): React.ReactNode {
    if (blocks.length === 0) {
        return (
            <scrollbox ref={scrollboxRef} focusable={false} {...chatTranscriptScrollOptions()}>
                <text attributes={TextAttributes.DIM}>{''}</text>
            </scrollbox>
        );
    }
    const lastIndex = blocks.length - 1;
    return (
        <scrollbox ref={scrollboxRef} focusable={false} {...chatTranscriptScrollOptions()}>
            {blocks.map((block, index) => {
                const streaming = generating && index === lastIndex;
                return (
                    <MessageBlock
                        // biome-ignore lint/suspicious/noArrayIndexKey: chat blocks are append-only
                        key={`msg-${block.kind}-${index}`}
                        block={block}
                        toolOutputExpanded={toolOutputExpanded}
                        viewportColumns={viewportColumns}
                        {...(streaming ? { isStreaming: true } : {})}
                    />
                );
            })}
        </scrollbox>
    );
}
