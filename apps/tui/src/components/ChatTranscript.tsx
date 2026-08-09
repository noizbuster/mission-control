/** @jsxImportSource @opentui/solid */

import type { ChatBlock } from '@mission-control/tui/chat';
import {
    type BoxRenderable,
    MacOSScrollAccel,
    type ScrollAcceleration,
    type ScrollBoxRenderable,
    TextAttributes,
} from '@opentui/core';
import { useTerminalDimensions } from '@opentui/solid';
import { createEffect, createMemo, createSignal, Index, type Accessor, type JSX, onCleanup, Show } from 'solid-js';
import { createTranscriptHeightCache, fingerprintTranscriptIds } from '../state/transcript-height-cache';
import type { TranscriptPart } from '../state/transcript-part';
import { estimateLegacyBlockHeight, estimateTranscriptPartHeight } from '../state/transcript-row-metrics';
import {
    anchorIndexForTranscriptOffset,
    DEFAULT_TRANSCRIPT_RENDER_LIMIT,
    formatHiddenTranscriptBanner,
    selectTranscriptWindowByHeight,
    transcriptWindowSpacerHeights,
} from '../state/transcript-windowing';
import { LegacyMessageBlock } from './LegacyTranscriptRenderer';
import { TranscriptPartRenderer } from './TranscriptPartRenderer';

export interface ChatScrollboxHandle {
    readonly get: () => ChatScrollboxSurface | undefined;
    readonly set: (renderable: ScrollBoxRenderable) => void;
    readonly clear: () => void;
    /** Bumps on attach/detach so Solid effects can track native ref lifecycle. */
    readonly generation?: Accessor<number>;
}

type ChatScrollTarget = number | { readonly x: number; readonly y: number };

export interface ChatScrollboxSurface {
    readonly scrollHeight: number;
    /** OpenTUI ScrollBox vertical offset (present on native renderable). */
    readonly scrollY?: number;
    readonly height?: number;
    onSizeChange?: (() => void) | undefined;
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
    readonly activeAssistantMessageId: string | undefined;
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
    // Bidirectional render window: sticky-bottom while at/near the live tail,
    // otherwise center on a scroll-estimated absolute anchor so PgUp can walk
    // older live rows without mounting the entire 500-part store.
    // Measured OpenTUI row heights override heuristics once a row has mounted.
    const heightCache = createTranscriptHeightCache();
    const [heightGeneration, setHeightGeneration] = createSignal(0);
    onCleanup(
        heightCache.subscribe(() => {
            setHeightGeneration(heightCache.getGeneration());
        }),
    );
    const [anchorIndex, setAnchorIndex] = createSignal<number | undefined>(undefined);

    // Track nodes we already wrapped so Solid re-refs do not stack size-change handlers.
    const measuredNodes = new WeakSet<object>();
    const bindMeasuredRow = (id: string, node: BoxRenderable | null | undefined): void => {
        if (node === null || node === undefined) return;
        const record = (height: number): void => {
            if (height > 0) heightCache.set(id, height);
        };
        // Immediate sample (first layout may already be resolved).
        record(node.height);
        if (measuredNodes.has(node)) {
            // Still refresh the bound id's height on re-bind without stacking handlers.
            return;
        }
        measuredNodes.add(node);
        // Prefer OpenTUI's public layout size-change callback over interval polling.
        const previous = node.onSizeChange;
        node.onSizeChange = () => {
            record(node.height);
            previous?.();
        };
    };

    const typedHeightAt = (part: TranscriptPart): number =>
        heightCache.get(part.id, estimateTranscriptPartHeight(part, dimensions().width));
    const legacyHeightAt = (block: ChatBlock, index: number): number => {
        const id = 'legacy-' + String(index) + '-' + block.kind;
        return heightCache.get(id, estimateLegacyBlockHeight(block, dimensions().width));
    };
    let sampledHeightGeneration = -1;
    let sampledViewportColumns = -1;
    let sampledTypedParts: readonly TranscriptPart[] | undefined;
    let sampledLegacyBlocks: readonly ChatBlock[] | undefined;
    let sampledHeights: readonly number[] = [];
    const currentHeightAt = (index: number): number => {
        const generation = heightGeneration();
        const viewportColumns = dimensions().width;
        const typedParts = props.transcriptParts;
        const legacyBlocks = props.blocks;
        if (
            generation !== sampledHeightGeneration ||
            viewportColumns !== sampledViewportColumns ||
            typedParts !== sampledTypedParts ||
            legacyBlocks !== sampledLegacyBlocks
        ) {
            sampledHeightGeneration = generation;
            sampledViewportColumns = viewportColumns;
            sampledTypedParts = typedParts;
            sampledLegacyBlocks = legacyBlocks;
            sampledHeights =
                typedParts.length > 0
                    ? typedParts.map((part) => typedHeightAt(part))
                    : legacyBlocks.map((block, blockIndex) => legacyHeightAt(block, blockIndex));
        }
        return sampledHeights[index] ?? 1;
    };

    createEffect(() => {
        // While generating, prefer sticky-bottom so stream rows stay mounted.
        if (props.generating) {
            setAnchorIndex(undefined);
            return;
        }
        const sample = (): void => {
            const box = props.scrollboxRef.get();
            if (box === undefined) return;
            const hasTypedParts = props.transcriptParts.length > 0;
            const total = hasTypedParts ? props.transcriptParts.length : props.blocks.length;
            if (total === 0) {
                setAnchorIndex(undefined);
                return;
            }
            const scrollY = typeof box.scrollY === 'number' ? box.scrollY : 0;
            const viewportHeight = typeof box.height === 'number' && box.height > 0 ? box.height : dimensions().height;
            const maxScrollY = Math.max(0, box.scrollHeight - viewportHeight);
            // Near bottom → sticky tail (undefined anchor).
            if (maxScrollY <= 0 || scrollY >= maxScrollY - 1) {
                setAnchorIndex(undefined);
                return;
            }
            // The scrollbox contains one leading spacer plus a one-row hidden
            // banner whenever the bounded window omits rows. Remove that chrome
            // before resolving the native offset against logical row heights.
            const fixedLeadingRows = 1 + (total > DEFAULT_TRANSCRIPT_RENDER_LIMIT ? 1 : 0);
            setAnchorIndex(
                anchorIndexForTranscriptOffset({
                    totalCount: total,
                    offsetRows: Math.max(0, scrollY - fixedLeadingRows),
                    heightAt: currentHeightAt,
                }),
            );
        };
        sample();
        // Layout-callback path: re-sample when the scrollbox itself resizes.
        const box = props.scrollboxRef.get();
        let previous: (() => void) | undefined;
        if (box !== undefined) {
            previous = box.onSizeChange;
            box.onSizeChange = () => {
                sample();
                previous?.();
            };
        }
        // Fallback poll for scrollY changes (wheel/key scroll without resize).
        const interval = setInterval(sample, 160);
        onCleanup(() => {
            clearInterval(interval);
            if (box !== undefined) {
                if (previous === undefined) {
                    delete box.onSizeChange;
                } else {
                    box.onSizeChange = previous;
                }
            }
        });
    });

    const viewportRows = () => {
        const box = props.scrollboxRef.get();
        if (typeof box?.height === 'number' && box.height > 0) return box.height;
        return Math.max(8, dimensions().height - 8);
    };

    const typedWindow = createMemo(() => {
        void heightGeneration();
        const currentAnchorIndex = anchorIndex();
        return selectTranscriptWindowByHeight({
            parts: props.transcriptParts,
            limit: DEFAULT_TRANSCRIPT_RENDER_LIMIT,
            ...(currentAnchorIndex === undefined ? {} : { anchorIndex: currentAnchorIndex }),
            viewportRows: viewportRows(),
            heightAt: typedHeightAt,
        });
    });
    const legacyWindow = createMemo(() => {
        void heightGeneration();
        const currentAnchorIndex = anchorIndex();
        return selectTranscriptWindowByHeight({
            parts: props.blocks,
            limit: DEFAULT_TRANSCRIPT_RENDER_LIMIT,
            ...(currentAnchorIndex === undefined ? {} : { anchorIndex: currentAnchorIndex }),
            viewportRows: viewportRows(),
            heightAt: legacyHeightAt,
        });
    });

    const typedSpacers = createMemo(() =>
        transcriptWindowSpacerHeights({
            parts: props.transcriptParts,
            window: typedWindow(),
            heightAt: typedHeightAt,
        }),
    );
    const legacySpacers = createMemo(() =>
        transcriptWindowSpacerHeights({
            parts: props.blocks,
            window: legacyWindow(),
            heightAt: legacyHeightAt,
        }),
    );

    // GC measured ids that left the live store (session switch / clamp).
    createEffect(() => {
        const idList: string[] = [];
        for (const part of props.transcriptParts) idList.push(part.id);
        for (let i = 0; i < props.blocks.length; i += 1) {
            const block = props.blocks[i];
            if (block !== undefined) idList.push('legacy-' + String(i) + '-' + block.kind);
        }
        heightCache.retain(new Set(idList), fingerprintTranscriptIds(idList));
    });
    const hiddenBanner = createMemo(() => {
        if (props.transcriptParts.length > 0) {
            const w = typedWindow();
            return formatHiddenTranscriptBanner(w.hiddenBefore, w.hiddenAfter);
        }
        const w = legacyWindow();
        return formatHiddenTranscriptBanner(w.hiddenBefore, w.hiddenAfter);
    });

    return (
        <scrollbox
            ref={(renderable: ScrollBoxRenderable) => props.scrollboxRef.set(renderable)}
            focusable={false}
            {...chatTranscriptScrollOptions()}
        >
            <Show when={hiddenBanner()}>
                {(text) => (
                    <box height={1} paddingLeft={1} paddingRight={1} flexShrink={0}>
                        <text attributes={TextAttributes.DIM}>{text()}</text>
                    </box>
                )}
            </Show>
            <Show
                when={props.transcriptParts.length > 0}
                fallback={
                    <>
                        <LegacyTranscriptBlocks
                            blocks={legacyWindow().visibleParts}
                            absoluteStartIndex={legacyWindow().startIndex}
                            totalBlockCount={legacyWindow().totalCount}
                            beforeSpacerRows={legacySpacers().beforeRows}
                            generating={props.generating}
                            toolOutputExpanded={props.toolOutputExpanded}
                            viewportColumns={dimensions().width}
                            onMeasureHeight={bindMeasuredRow}
                        />
                        <Show when={legacySpacers().afterRows > 0}>
                            <box height={legacySpacers().afterRows} flexShrink={0} />
                        </Show>
                    </>
                }
            >
                <box height={1} />
                <Show when={typedSpacers().beforeRows > 0}>
                    <box height={typedSpacers().beforeRows} flexShrink={0} />
                </Show>
                <Index each={typedWindow().visibleParts}>
                    {(part, index) => {
                        const absoluteIndex = () => typedWindow().startIndex + index;
                        return (
                            <box
                                ref={(node) => {
                                    bindMeasuredRow(part().id, node);
                                }}
                            >
                                <TranscriptPartRenderer
                                    part={part()}
                                    showThinking={props.showThinking}
                                    toolOutputExpanded={props.toolOutputExpanded}
                                    transcriptParts={props.transcriptParts}
                                    viewportColumns={dimensions().width}
                                    isFirst={absoluteIndex() === 0}
                                    isLast={absoluteIndex() === typedWindow().totalCount - 1}
                                    generating={props.generating}
                                    {...(props.activeAssistantMessageId !== undefined
                                        ? { activeAssistantMessageId: props.activeAssistantMessageId }
                                        : {})}
                                />
                            </box>
                        );
                    }}
                </Index>
                <Show when={typedSpacers().afterRows > 0}>
                    <box height={typedSpacers().afterRows} flexShrink={0} />
                </Show>
            </Show>
        </scrollbox>
    );
}

function LegacyTranscriptBlocks(props: {
    readonly blocks: readonly ChatBlock[];
    readonly absoluteStartIndex: number;
    readonly totalBlockCount: number;
    readonly beforeSpacerRows: number;
    readonly generating: boolean;
    readonly toolOutputExpanded: boolean;
    readonly viewportColumns: number;
    readonly onMeasureHeight?: (id: string, node: BoxRenderable) => void;
}): JSX.Element {
    return (
        <Show when={props.blocks.length > 0} fallback={<text attributes={TextAttributes.DIM}>{''}</text>}>
            <box height={1} />
            <Show when={props.beforeSpacerRows > 0}>
                <box height={props.beforeSpacerRows} flexShrink={0} />
            </Show>
            <Index each={props.blocks}>
                {(block, index) => {
                    const absoluteIndex = () => props.absoluteStartIndex + index;
                    const measureId = () => 'legacy-' + String(absoluteIndex()) + '-' + block().kind;
                    return (
                        <box
                            ref={(node) => {
                                props.onMeasureHeight?.(measureId(), node);
                            }}
                        >
                            <LegacyMessageBlock
                                block={block()}
                                toolOutputExpanded={props.toolOutputExpanded}
                                viewportColumns={props.viewportColumns}
                                isFirst={absoluteIndex() === 0}
                                isStreaming={props.generating && absoluteIndex() === props.totalBlockCount - 1}
                            />
                        </box>
                    );
                }}
            </Index>
        </Show>
    );
}
