/** @jsxImportSource @opentui/solid */

import { type JSX, Show } from 'solid-js';
import type { TranscriptPartStatus } from '../state/transcript-part';
import {
    CHAT_ASSISTANT_PAD_LEFT,
    CHAT_PANEL_BG,
    CHAT_TOOL_ICON_WIDTH,
    CHAT_USER_MARGIN_TOP,
    CHAT_USER_PAD_X,
    CHAT_USER_PAD_Y,
} from './chat-theme';
import { LEFT_ACCENT_BORDER } from './overlay-theme';
import { toolStatusPresentation } from './ToolCard';

export function TypedBlockPanel(props: {
    readonly title: string;
    readonly expanded: boolean;
    readonly children: JSX.Element;
    readonly status?: TranscriptPartStatus;
}): JSX.Element {
    const status = () => toolStatusPresentation(props.status);
    const header = () => {
        const presentation = status();
        return presentation.label === undefined || presentation.glyph === undefined
            ? props.title
            : `[${presentation.glyph}] ${presentation.label}: ${props.title}`;
    };
    return (
        <box
            border={['left']}
            customBorderChars={LEFT_ACCENT_BORDER}
            borderColor={CHAT_PANEL_BG}
            paddingTop={CHAT_USER_PAD_Y}
            paddingBottom={CHAT_USER_PAD_Y}
            paddingLeft={CHAT_USER_PAD_X}
            backgroundColor={CHAT_PANEL_BG}
            flexDirection="column"
            flexShrink={0}
            gap={CHAT_USER_MARGIN_TOP}
        >
            <box flexDirection="row" paddingLeft={CHAT_ASSISTANT_PAD_LEFT}>
                <text width={CHAT_TOOL_ICON_WIDTH} fg={status().color}>
                    {props.status === undefined ? '>' : ''}
                </text>
                <text selectable flexGrow={1} fg={status().color}>
                    {header()}
                </text>
            </box>
            <Show when={props.expanded}>{props.children}</Show>
        </box>
    );
}
