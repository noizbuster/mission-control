/** @jsxImportSource @opentui/solid */

import { parseMessageBlocks } from '@mission-control/tui/chat';
import { TextAttributes } from '@opentui/core';
import { For, Index, type JSX, Show } from 'solid-js';
import type {
    AssistantTranscriptPart,
    BlockToolTranscriptPart,
    CodeTranscriptPart,
    CommandTranscriptPart,
    DiffTranscriptPart,
    ErrorTranscriptPart,
    EventTranscriptPart,
    InlineToolTranscriptPart,
    LegacyTranscriptPart,
    ReasoningTranscriptPart,
    StatusTranscriptPart,
    SubagentTranscriptPart,
    UserTranscriptPart,
} from '../state/transcript-part';
import { CHAT_ASSISTANT_PAD_LEFT, CHAT_TEXT_MUTED, CHAT_USER_MARGIN_TOP, CHAT_USER_PAD_X } from './chat-theme';
import { DiffView } from './diff/DiffView';
import {
    ErrorMessagePanel,
    LegacyMessageBlock,
    MarkdownPanel,
    ThinkingHeader,
    UserMessagePanel,
} from './LegacyTranscriptRenderer';
import { darkTheme } from './markdown/interactive-theme';
import { Markdown } from './markdown/Markdown';
import type { TerminalMarkdownTheme } from './markdown/theme';
import { ToolCard } from './ToolCard';
import { TypedBlockPanel } from './TypedBlockPanel';
import {
    buildFencedCodeMarkdown,
    isFinalLegacyPartStreaming,
    isTranscriptPartStreaming,
    presentTranscriptPart,
    transcriptContentWidth,
} from './transcript-part-presentation';

const thinkingTheme: TerminalMarkdownTheme = {
    ...darkTheme,
    defaultTextStyle: { attributes: { italic: true, dim: true } },
};

export function TypedUserRow(props: { readonly part: UserTranscriptPart; readonly isFirst: boolean }): JSX.Element {
    return <UserMessagePanel lines={props.part.text.split('\n')} prefix="" isFirst={props.isFirst} />;
}

export function TypedAssistantRow(props: {
    readonly part: AssistantTranscriptPart;
    readonly viewportColumns: number;
}): JSX.Element {
    return (
        <MarkdownPanel
            text={props.part.text}
            theme={darkTheme}
            paddingLeft={CHAT_ASSISTANT_PAD_LEFT}
            marginTop={CHAT_USER_MARGIN_TOP}
            viewportColumns={props.viewportColumns}
            streaming={isTranscriptPartStreaming(props.part.status)}
        />
    );
}

export function TypedReasoningRow(props: {
    readonly part: ReasoningTranscriptPart;
    readonly showThinking: boolean;
    readonly viewportColumns: number;
}): JSX.Element {
    return (
        <Show when={props.showThinking}>
            <box
                paddingLeft={CHAT_ASSISTANT_PAD_LEFT}
                marginTop={CHAT_USER_MARGIN_TOP}
                flexDirection="column"
                flexShrink={0}
            >
                <ThinkingHeader streaming={isTranscriptPartStreaming(props.part.status)} />
                <Show when={props.part.text.trim().length > 0}>
                    <box marginTop={CHAT_USER_MARGIN_TOP}>
                        <Markdown
                            text={props.part.text}
                            theme={thinkingTheme}
                            width={transcriptContentWidth(props.viewportColumns, CHAT_ASSISTANT_PAD_LEFT)}
                            streaming={isTranscriptPartStreaming(props.part.status)}
                        />
                    </box>
                </Show>
            </box>
        </Show>
    );
}

export function TypedToolRow(props: {
    readonly part: InlineToolTranscriptPart | BlockToolTranscriptPart;
    readonly expanded: boolean;
}): JSX.Element {
    const presentation = () => presentTranscriptPart(props.part);
    const isActive = () =>
        props.part.status === 'pending' || props.part.status === 'running' || props.part.status === 'streaming';
    return (
        <ToolCard
            lines={presentation().lines}
            title={presentation().title}
            expanded={props.expanded && (presentation().lines.length > 1 || !isActive())}
            {...(props.part.status === undefined ? {} : { status: props.part.status })}
        />
    );
}

export function TypedDiffRow(props: { readonly part: DiffTranscriptPart; readonly expanded: boolean }): JSX.Element {
    const presentation = () => presentTranscriptPart(props.part);
    return (
        <TypedBlockPanel
            title={presentation().title}
            expanded={props.expanded}
            {...(props.part.status === undefined ? {} : { status: props.part.status })}
        >
            <DiffView
                diff={props.part.text}
                {...(props.part.filePath !== undefined ? { filePath: props.part.filePath } : {})}
            />
        </TypedBlockPanel>
    );
}

export function TypedCodeRow(props: {
    readonly part: CodeTranscriptPart;
    readonly expanded: boolean;
    readonly viewportColumns: number;
}): JSX.Element {
    const presentation = () => presentTranscriptPart(props.part);
    return (
        <TypedBlockPanel
            title={presentation().title}
            expanded={props.expanded}
            {...(props.part.status === undefined ? {} : { status: props.part.status })}
        >
            <Markdown
                text={buildFencedCodeMarkdown(props.part.text, props.part.language)}
                theme={darkTheme}
                width={transcriptContentWidth(props.viewportColumns, CHAT_USER_PAD_X)}
                streaming={isTranscriptPartStreaming(props.part.status)}
            />
        </TypedBlockPanel>
    );
}

export function TypedCommandRow(props: {
    readonly part: CommandTranscriptPart;
    readonly expanded: boolean;
}): JSX.Element {
    const presentation = () => presentTranscriptPart(props.part);
    return (
        <ToolCard
            lines={presentation().lines}
            title={presentation().title}
            expanded={props.expanded}
            bodyMode="plain"
            {...(props.part.status === undefined ? {} : { status: props.part.status })}
        />
    );
}

export function TypedSubagentRow(props: {
    readonly part: SubagentTranscriptPart;
    readonly expanded: boolean;
}): JSX.Element {
    const presentation = () => presentTranscriptPart(props.part);
    const isActive = () =>
        props.part.status === 'pending' || props.part.status === 'running' || props.part.status === 'streaming';
    return (
        <ToolCard
            lines={presentation().lines}
            title={presentation().title}
            expanded={props.expanded && !isActive()}
            {...(props.part.status === undefined ? {} : { status: props.part.status })}
        />
    );
}

export function TypedNoticeRow(props: { readonly part: StatusTranscriptPart | EventTranscriptPart }): JSX.Element {
    const presentation = () => presentTranscriptPart(props.part);
    return (
        <box paddingLeft={CHAT_ASSISTANT_PAD_LEFT} flexDirection="column" flexShrink={0}>
            <For each={presentation().lines}>
                {(line, index) => (
                    <text selectable attributes={TextAttributes.DIM} fg={CHAT_TEXT_MUTED}>
                        {index() === 0 ? `${presentation().title}: ${line}` : line}
                    </text>
                )}
            </For>
        </box>
    );
}

export function TypedErrorRow(props: { readonly part: ErrorTranscriptPart }): JSX.Element {
    const presentation = () => presentTranscriptPart(props.part);
    return <ErrorMessagePanel lines={[presentation().title, ...presentation().lines]} prefix="" />;
}

export function TypedLegacyRow(props: {
    readonly part: LegacyTranscriptPart;
    readonly generating: boolean;
    readonly toolOutputExpanded: boolean;
    readonly viewportColumns: number;
    readonly isFirst: boolean;
    readonly isLast: boolean;
}): JSX.Element {
    const blocks = () => parseMessageBlocks(props.part.text);
    return (
        <Index each={blocks()}>
            {(block, index) => (
                <LegacyMessageBlock
                    block={block()}
                    toolOutputExpanded={props.toolOutputExpanded}
                    viewportColumns={props.viewportColumns}
                    isFirst={props.isFirst && index === 0}
                    isStreaming={
                        isFinalLegacyPartStreaming(props.generating, props.isLast) && index === blocks().length - 1
                    }
                />
            )}
        </Index>
    );
}
