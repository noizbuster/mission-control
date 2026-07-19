/** @jsxImportSource @opentui/solid */

import { blockPrefix, type ChatBlock, joinBlockText, readToolBlockTitle } from '@mission-control/tui/chat';
import { TextAttributes } from '@opentui/core';
import { For, type JSX, Match, Show, Switch } from 'solid-js';
import { sanitizeTerminalDisplayText } from '../state/terminal-display-sanitizer';
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
import { transcriptContentWidth } from './transcript-part-presentation';

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

export function MarkdownPanel(props: MarkdownPanelProps): JSX.Element {
    const padLeft = () => props.paddingLeft ?? CHAT_ASSISTANT_PAD_LEFT;
    const barWidth = () => props.barWidth ?? 0;
    const contentWidth = () => transcriptContentWidth(props.viewportColumns, padLeft() + barWidth());

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

const thinkingTheme: TerminalMarkdownTheme = {
    ...darkTheme,
    defaultTextStyle: { attributes: { italic: true, dim: true } },
};

export type LegacyMessageBlockProps = {
    readonly block: ChatBlock;
    readonly isStreaming?: boolean;
    readonly toolOutputExpanded: boolean;
    readonly viewportColumns: number;
    readonly isFirst?: boolean;
};

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
                    {(line) => (
                        <text selectable fg={CHAT_TEXT}>
                            {stripPrefix(line, props.prefix)}
                        </text>
                    )}
                </For>
            </box>
        </box>
    );
}

export function ErrorMessagePanel(props: { readonly lines: readonly string[]; readonly prefix: string }): JSX.Element {
    return (
        <box
            border={['left']}
            borderColor={CHAT_ERROR}
            customBorderChars={LEFT_ACCENT_BORDER}
            marginTop={CHAT_USER_MARGIN_TOP}
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
                    {(line) => (
                        <text selectable fg={CHAT_ERROR}>
                            {stripPrefix(line, props.prefix)}
                        </text>
                    )}
                </For>
            </box>
        </box>
    );
}

export function ThinkingHeader(props: { readonly streaming: boolean }): JSX.Element {
    return (
        <text fg={CHAT_WARNING} attributes={TextAttributes.DIM}>
            {props.streaming ? 'Thinking' : 'Thought'}
        </text>
    );
}

export function LegacyMessageBlock(props: LegacyMessageBlockProps): JSX.Element {
    const kind = () => props.block.kind;
    const lines = () => props.block.lines.map(sanitizeTerminalDisplayText);
    const prefix = () => blockPrefix[kind()];
    const joined = () => joinBlockText(lines(), prefix());
    const streaming = () => props.isStreaming === true;
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
                <box marginTop={CHAT_USER_MARGIN_TOP}>
                    <ToolCard
                        lines={lines()}
                        expanded={props.toolOutputExpanded}
                        {...(() => {
                            const title = readToolBlockTitle(lines());
                            return title === undefined ? {} : { title };
                        })()}
                    />
                </box>
            </Match>
            <Match when={kind() === 'thinking'}>
                <box
                    paddingLeft={CHAT_ASSISTANT_PAD_LEFT}
                    marginTop={CHAT_USER_MARGIN_TOP}
                    flexDirection="column"
                    flexShrink={0}
                >
                    <ThinkingHeader streaming={streaming()} />
                    <Show when={joined().trim().length > 0}>
                        <box marginTop={CHAT_USER_MARGIN_TOP}>
                            <Markdown
                                text={joined()}
                                theme={thinkingTheme}
                                width={transcriptContentWidth(props.viewportColumns, CHAT_ASSISTANT_PAD_LEFT)}
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
                    marginTop={CHAT_USER_MARGIN_TOP}
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

function stripPrefix(line: string, prefix: string): string {
    return prefix.length > 0 && line.startsWith(prefix) ? line.slice(prefix.length) : line;
}
