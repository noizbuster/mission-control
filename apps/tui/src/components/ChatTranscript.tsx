/** @jsxImportSource @opentui/solid */

import { blockPrefix, type ChatBlock, joinBlockText, readToolBlockTitle } from '@mission-control/tui/chat';
import { MacOSScrollAccel, type ScrollAcceleration, type ScrollBoxRenderable, TextAttributes } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/solid';
import { For, Index, Match, Show, Switch, type JSX } from 'solid-js';
import {
    CHAT_ASSISTANT_PAD_LEFT,
    CHAT_ERROR,
    CHAT_PANEL_BG,
    CHAT_PRIMARY,
    CHAT_TEXT,
    CHAT_TEXT_MUTED,
    CHAT_USER_MARGIN_TOP,
    CHAT_USER_PAD_X,
    CHAT_USER_PAD_Y,
    CHAT_WARNING,
} from './chat-theme';
import { darkTheme } from './markdown/interactive-theme';
import { Markdown } from './markdown/Markdown';
import type { TerminalMarkdownTheme } from './markdown/theme';
import { LEFT_ACCENT_BORDER } from './overlay-theme';
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

/**
 * OpenCode TextPart-style assistant markdown: left inset only, no colored bar.
 * Width accounts for the padding so CJK wrap stays inside the viewport.
 */
export type MarkdownPanelProps = {
    readonly text: string;
    readonly theme: TerminalMarkdownTheme;
    readonly barColor?: string;
    readonly barWidth?: number;
    readonly streaming?: boolean;
    readonly marginTop?: number;
    readonly paddingLeft?: number;
    readonly viewportColumns: number;
};

export function MarkdownPanelBase(props: MarkdownPanelProps): JSX.Element {
    const padLeft = () => props.paddingLeft ?? CHAT_ASSISTANT_PAD_LEFT;
    const barWidth = () => props.barWidth ?? 0;
    const contentWidth = () => Math.max(1, props.viewportColumns - padLeft() - barWidth());

    if (props.barColor !== undefined && (props.barWidth ?? 0) > 0) {
        return (
            <box flexDirection="row" {...(props.marginTop !== undefined ? { marginTop: props.marginTop } : {})}>
                <box width={barWidth()} backgroundColor={props.barColor} shouldFill={true} flexShrink={0} />
                <box flexDirection="column" flexGrow={1} minWidth={0}>
                    <Markdown
                        text={props.text}
                        theme={props.theme}
                        width={contentWidth()}
                        streaming={props.streaming === true}
                    />
                </box>
            </box>
        );
    }

    return (
        <box
            flexDirection="column"
            paddingLeft={padLeft()}
            flexShrink={0}
            {...(props.marginTop !== undefined ? { marginTop: props.marginTop } : {})}
        >
            <Markdown
                text={props.text}
                theme={props.theme}
                width={contentWidth()}
                streaming={props.streaming === true}
            />
        </box>
    );
}

export const MarkdownPanel = MarkdownPanelBase;

const thinkingTheme: TerminalMarkdownTheme = {
    ...darkTheme,
    defaultTextStyle: { attributes: { italic: true, dim: true } },
};

export type MessageBlockProps = {
    readonly block: ChatBlock;
    readonly isStreaming?: boolean;
    readonly toolOutputExpanded: boolean;
    readonly viewportColumns: number;
    readonly isFirst?: boolean;
};

/**
 * OpenCode UserMessage chrome: left `┃` accent, panel fill, padded body text.
 */
export function UserMessagePanel(props: {
    readonly lines: readonly string[];
    readonly prefix: string;
    readonly isFirst: boolean;
}): JSX.Element {
    return (
        <box
            border={['left']}
            borderColor={CHAT_PRIMARY}
            customBorderChars={LEFT_ACCENT_BORDER}
            marginTop={props.isFirst ? 0 : CHAT_USER_MARGIN_TOP}
            flexShrink={0}
        >
            <box
                paddingTop={CHAT_USER_PAD_Y}
                paddingBottom={CHAT_USER_PAD_Y}
                paddingLeft={CHAT_USER_PAD_X}
                backgroundColor={CHAT_PANEL_BG}
                flexShrink={0}
                flexDirection="column"
            >
                <For each={props.lines}>
                    {(line) => {
                        const content = () => {
                            const p = props.prefix;
                            return p.length > 0 && line.startsWith(p) ? line.slice(p.length) : line;
                        };
                        return (
                            <text selectable fg={CHAT_TEXT}>
                                {content()}
                            </text>
                        );
                    }}
                </For>
            </box>
        </box>
    );
}

/**
 * OpenCode error panel: left accent in error color + panel background.
 */
export function ErrorMessagePanel(props: {
    readonly lines: readonly string[];
    readonly prefix: string;
}): JSX.Element {
    return (
        <box
            border={['left']}
            borderColor={CHAT_ERROR}
            customBorderChars={LEFT_ACCENT_BORDER}
            marginTop={1}
            flexShrink={0}
        >
            <box
                paddingTop={CHAT_USER_PAD_Y}
                paddingBottom={CHAT_USER_PAD_Y}
                paddingLeft={CHAT_USER_PAD_X}
                backgroundColor={CHAT_PANEL_BG}
                flexDirection="column"
                flexShrink={0}
            >
                <For each={props.lines}>
                    {(line) => {
                        const content = () => {
                            const p = props.prefix;
                            return p.length > 0 && line.startsWith(p) ? line.slice(p.length) : line;
                        };
                        return (
                            <text selectable fg={CHAT_ERROR}>
                                {content()}
                            </text>
                        );
                    }}
                </For>
            </box>
        </box>
    );
}

/**
 * OpenCode ReasoningPart header: "Thinking" while streaming, "Thought" when done.
 */
export function ThinkingHeader(props: { readonly streaming: boolean }): JSX.Element {
    return (
        <text fg={CHAT_WARNING} attributes={TextAttributes.DIM}>
            {props.streaming ? 'Thinking' : 'Thought'}
        </text>
    );
}

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
    const isFirst = () => props.isFirst === true;

    return (
        <Switch>
            <Match when={kind() === 'system'}>
                <box flexDirection="column" paddingLeft={CHAT_ASSISTANT_PAD_LEFT}>
                    <For each={lines()}>
                        {(line) => (
                            <text selectable attributes={TextAttributes.DIM} fg={CHAT_TEXT_MUTED}>
                                {line}
                            </text>
                        )}
                    </For>
                </box>
            </Match>
            <Match when={kind() === 'tool'}>
                <box marginTop={1}>
                    {(() => {
                        const title = toolTitle();
                        return (
                            <ToolCard
                                lines={lines()}
                                expanded={props.toolOutputExpanded}
                                {...(title !== undefined ? { title } : {})}
                            />
                        );
                    })()}
                </box>
            </Match>
            <Match when={kind() === 'thinking'}>
                <box paddingLeft={CHAT_ASSISTANT_PAD_LEFT} marginTop={1} flexDirection="column" flexShrink={0}>
                    <ThinkingHeader streaming={streaming()} />
                    <Show when={joined().trim().length > 0}>
                        <box marginTop={1}>
                            <Markdown
                                text={joined()}
                                theme={thinkingTheme}
                                width={Math.max(1, props.viewportColumns - CHAT_ASSISTANT_PAD_LEFT)}
                                streaming={streaming()}
                            />
                        </box>
                    </Show>
                </box>
            </Match>
            <Match when={kind() === 'assistant'}>
                <MarkdownPanel
                    text={joined()}
                    theme={darkTheme}
                    paddingLeft={CHAT_ASSISTANT_PAD_LEFT}
                    marginTop={1}
                    viewportColumns={props.viewportColumns}
                    streaming={streaming()}
                />
            </Match>
            <Match when={kind() === 'error'}>
                <ErrorMessagePanel lines={lines()} prefix={prefix()} />
            </Match>
            <Match when={kind() === 'user'}>
                <UserMessagePanel lines={lines()} prefix={prefix()} isFirst={isFirst()} />
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
                <box height={1} />
                <Index each={props.blocks}>
                    {(block, index) => (
                        <MessageBlock
                            block={block()}
                            toolOutputExpanded={props.toolOutputExpanded}
                            viewportColumns={dimensions().width}
                            isFirst={index === 0}
                            isStreaming={props.generating && index === props.blocks.length - 1}
                        />
                    )}
                </Index>
            </Show>
        </scrollbox>
    );
}
