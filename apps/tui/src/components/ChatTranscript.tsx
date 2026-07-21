/** @jsxImportSource @opentui/solid */

import type { ChatBlock } from '@mission-control/tui/chat';
import { MacOSScrollAccel, type ScrollAcceleration, type ScrollBoxRenderable, TextAttributes } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/solid';
import { Index, type JSX, Show } from 'solid-js';
import type { TranscriptPart } from '../state/transcript-part';
import { LegacyMessageBlock } from './LegacyTranscriptRenderer';
import { TranscriptPartRenderer } from './TranscriptPartRenderer';

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
        ...(maxHeight === undefined ? {} : { maxHeight }),
    };
}

export type ChatTranscriptProps = {
    readonly blocks: readonly ChatBlock[];
    readonly transcriptParts: readonly TranscriptPart[];
    readonly scrollboxRef: ChatScrollboxHandle;
    readonly generating: boolean;
    readonly showThinking: boolean;
    readonly toolOutputExpanded: boolean;
    readonly activeAssistantMessageId?: string;
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

export function ChatTranscript(props: ChatTranscriptProps): JSX.Element {
    const dimensions = useTerminalDimensions();

    return (
        <scrollbox
            ref={(renderable: ScrollBoxRenderable) => props.scrollboxRef.set(renderable)}
            focusable={false}
            {...chatTranscriptScrollOptions()}
        >
            <Show
                when={props.transcriptParts.length > 0}
                fallback={
                    <LegacyTranscriptBlocks
                        blocks={props.blocks}
                        generating={props.generating}
                        toolOutputExpanded={props.toolOutputExpanded}
                        viewportColumns={dimensions().width}
                    />
                }
            >
                <box height={1} />
                <Index each={props.transcriptParts}>
                    {(part, index) => (
                        <TranscriptPartRenderer
                            part={part()}
                            showThinking={props.showThinking}
                            toolOutputExpanded={props.toolOutputExpanded}
                            transcriptParts={props.transcriptParts}
                            viewportColumns={dimensions().width}
                            isFirst={index === 0}
                            isLast={index === props.transcriptParts.length - 1}
                            generating={props.generating}
                            {...(props.activeAssistantMessageId !== undefined
                                ? { activeAssistantMessageId: props.activeAssistantMessageId }
                                : {})}
                        />
                    )}
                </Index>
            </Show>
        </scrollbox>
    );
}

function LegacyTranscriptBlocks(props: {
    readonly blocks: readonly ChatBlock[];
    readonly generating: boolean;
    readonly toolOutputExpanded: boolean;
    readonly viewportColumns: number;
}): JSX.Element {
    return (
        <Show when={props.blocks.length > 0} fallback={<text attributes={TextAttributes.DIM}>{''}</text>}>
            <box height={1} />
            <Index each={props.blocks}>
                {(block, index) => (
                    <LegacyMessageBlock
                        block={block()}
                        toolOutputExpanded={props.toolOutputExpanded}
                        viewportColumns={props.viewportColumns}
                        isFirst={index === 0}
                        isStreaming={props.generating && index === props.blocks.length - 1}
                    />
                )}
            </Index>
        </Show>
    );
}
