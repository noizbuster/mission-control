/** @jsxImportSource @opentui/solid */

import { type JSX, Show } from 'solid-js';
import { sanitizeTranscriptPartForDisplay } from '../state/terminal-display-sanitizer';
import type { TranscriptPart } from '../state/transcript-part';
import { shouldHideToolPart } from '../state/transcript-visibility';
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
            return (
                <TypedAssistantRow
                    part={props.part}
                    viewportColumns={props.viewportColumns}
                    transcriptParts={props.transcriptParts}
                    toolOutputExpanded={props.toolOutputExpanded}
                    {...(props.activeAssistantMessageId !== undefined
                        ? { activeAssistantMessageId: props.activeAssistantMessageId }
                        : {})}
                />
            );
        case 'reasoning':
            return (
                <TypedReasoningRow
                    part={props.part}
                    showThinking={props.showThinking}
                    viewportColumns={props.viewportColumns}
                />
            );
        // Chip flag (toolOutputExpanded / Ctrl+O) is footer-only. Typed body rows always
        // pass expanded=true; lifecycle gates inside TypedToolRow/Subagent still apply.
        case 'inline-tool':
            if (shouldHideToolPart(props.part, props.activeAssistantMessageId)) return null;
            return <TypedToolRow part={props.part} expanded={true} />;
        case 'block-tool':
            if (shouldHideToolPart(props.part, props.activeAssistantMessageId)) return null;
            return <TypedToolRow part={props.part} expanded={true} />;
        case 'diff':
            if (shouldHideToolPart(props.part, props.activeAssistantMessageId)) return null;
            return <TypedDiffRow part={props.part} expanded={true} />;
        case 'code':
            return <TypedCodeRow part={props.part} expanded={true} viewportColumns={props.viewportColumns} />;
        case 'command':
            if (shouldHideToolPart(props.part, props.activeAssistantMessageId)) return null;
            return <TypedCommandRow part={props.part} expanded={true} />;
        case 'subagent':
            if (shouldHideToolPart(props.part, props.activeAssistantMessageId)) return null;
            return <TypedSubagentRow part={props.part} expanded={true} />;
        case 'status':
            return <TypedNoticeRow part={props.part} />;
        case 'event':
            return <TypedNoticeRow part={props.part} />;
        case 'error':
            return <TypedErrorRow part={props.part} />;
        case 'legacy':
            // Legacy tool blocks also ignore the chip flag so Ctrl+O never collapses bodies.
            return (
                <TypedLegacyRow
                    part={props.part}
                    generating={props.generating === true}
                    toolOutputExpanded={true}
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
