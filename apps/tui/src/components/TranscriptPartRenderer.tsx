/** @jsxImportSource @opentui/solid */

import { TOOL_AGGREGATE_DISPLAY_PATTERN } from '@mission-control/tui/chat';
import { type JSX, Show } from 'solid-js';
import { sanitizeTranscriptPartForDisplay } from '../state/terminal-display-sanitizer';
import type { TranscriptPart } from '../state/transcript-part';
import {
    TypedAssistantRow,
    TypedCodeRow,
    TypedCommandRow,
    TypedDiffRow,
    TypedErrorRow,
    TypedLegacyRow,
    TypedNoticeRow,
    TypedReasoningRow,
    TypedSubagentRow,
    TypedToolRow,
    TypedUserRow,
} from './TypedTranscriptRows';

export type TranscriptPartRendererProps = {
    readonly part: TranscriptPart;
    readonly showThinking: boolean;
    readonly toolOutputExpanded: boolean;
    readonly transcriptParts: readonly TranscriptPart[];
    readonly viewportColumns: number;
    readonly isFirst: boolean;
    readonly isLast: boolean;
    readonly generating?: boolean;
    readonly activeAssistantMessageId?: string;
};

export function TranscriptPartRenderer(props: TranscriptPartRendererProps): JSX.Element {
    const displayPart = () => sanitizeTranscriptPartForDisplay(props.part);
    return (
        <Show when={props.part.type} keyed>
            <TranscriptPartContent {...props} part={displayPart()} />
        </Show>
    );
}

function TranscriptPartContent(props: TranscriptPartRendererProps): JSX.Element {
    switch (props.part.type) {
        case 'user':
            return <TypedUserRow part={props.part} isFirst={props.isFirst} />;
        case 'assistant':
            return <TypedAssistantRow part={props.part} viewportColumns={props.viewportColumns} />;
        case 'reasoning':
            return (
                <TypedReasoningRow
                    part={props.part}
                    showThinking={props.showThinking}
                    viewportColumns={props.viewportColumns}
                />
            );
        case 'inline-tool':
            return <TypedToolRow part={props.part} expanded={props.toolOutputExpanded} />;
        case 'block-tool':
            return <TypedToolRow part={props.part} expanded={props.toolOutputExpanded} />;
        case 'diff':
            return <TypedDiffRow part={props.part} expanded={props.toolOutputExpanded} />;
        case 'code':
            return <TypedCodeRow part={props.part} expanded={props.toolOutputExpanded} viewportColumns={props.viewportColumns} />;
        case 'command':
            return <TypedCommandRow part={props.part} expanded={props.toolOutputExpanded} />;
        case 'subagent':
            return <TypedSubagentRow part={props.part} expanded={props.toolOutputExpanded} />;
        case 'status':
            if (TOOL_AGGREGATE_DISPLAY_PATTERN.test(props.part.text)) return null;
            return <TypedNoticeRow part={props.part} />;
        case 'event':
            return <TypedNoticeRow part={props.part} />;
        case 'error':
            return <TypedErrorRow part={props.part} />;
        case 'legacy':
            return (
                <TypedLegacyRow
                    part={props.part}
                    generating={props.generating === true}
                    toolOutputExpanded={props.toolOutputExpanded}
                    viewportColumns={props.viewportColumns}
                    isFirst={props.isFirst}
                    isLast={props.isLast}
                />
            );
        default:
            return assertNever(props.part);
    }
}

function assertNever(part: never): never {
    throw new Error(`Unexpected transcript part: ${JSON.stringify(part)}`);
}
