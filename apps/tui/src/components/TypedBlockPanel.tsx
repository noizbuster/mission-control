/** @jsxImportSource @opentui/solid */

import { type JSX, Show } from 'solid-js';
import type { TranscriptPartStatus } from '../state/transcript-part';
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
        <box flexDirection="column" flexShrink={0}>
            <box flexDirection="row">
                <text selectable flexGrow={1} fg={status().color}>
                    {header()}
                </text>
            </box>
            <Show when={props.expanded}>{props.children}</Show>
        </box>
    );
}
