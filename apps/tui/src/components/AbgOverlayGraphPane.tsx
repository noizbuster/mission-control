/** @jsxImportSource @opentui/solid */

import { truncateTerminalText } from '@mission-control/tui';
import { For, type JSX, Show } from 'solid-js';
import type { TerminalViewport } from '../platform/terminal-viewport';
import type { AbgOverlayState } from '../state/abg-overlay-state';
import type { PaneProps } from './AbgOverlayPanesA';
import { renderAbgGraphForDisplay, sanitizeAbgDisplayText } from './abg-display-projection';
import { graphStatusTheme, nodeStatusTheme, STATUS_FG_GRAY } from './abg-status-theme';
import { useSpinnerFrame } from './spinner';
import { type VisualGraphRow, visualGraphBoundsForViewport } from './visual-graph';

export type GraphPaneProps = PaneProps & {
    readonly viewport: TerminalViewport;
    readonly panX?: number;
};

const dimAttrs = { dim: true };
const boldAttrs = { bold: true };
const yellowFg = '#ffff00';

function truncate(text: string, max: number): string {
    return truncateTerminalText(sanitizeAbgDisplayText(text), max, '\u2026');
}

function isEmptyState(state: AbgOverlayState): boolean {
    return (
        state.activeGraphId === undefined ||
        state.graphStatus === undefined ||
        (state.nodes.size === 0 && state.recentEvents.length === 0)
    );
}

function renderVisualRow(row: VisualGraphRow, spinnerGlyph: string): JSX.Element {
    if (row.kind === 'connector') {
        const text = row.segments.map((segment) => segment.text).join('');
        return <text {...dimAttrs}>{text}</text>;
    }
    return (
        <box flexDirection="row">
            <For each={row.segments}>
                {(segment) => {
                    const fg = segment.status !== undefined ? nodeStatusTheme(segment.status).foreground : undefined;
                    return <text {...(fg !== undefined ? { fg } : dimAttrs)}>{segment.text}</text>;
                }}
            </For>
            {row.isActive ? <text {...(yellowFg !== undefined ? { fg: yellowFg } : {})}> {spinnerGlyph}</text> : null}
        </box>
    );
}

export function GraphPane(props: GraphPaneProps): JSX.Element {
    const { glyph: spinnerGlyph } = useSpinnerFrame();
    const graphBounds = () => visualGraphBoundsForViewport(props.viewport);
    const visual = () => {
        const state = props.state;
        if (isEmptyState(state)) return undefined;
        const bounds = graphBounds();
        return renderAbgGraphForDisplay({
            state,
            maxWidth: bounds.maxWidth,
            maxHeight: bounds.maxHeight,
            offsetX: props.panX ?? 0,
            offsetY: props.scrollOffset ?? 0,
        });
    };

    return (
        <Show
            when={!isEmptyState(props.state) && visual() !== undefined}
            fallback={
                <box flexDirection="column" marginTop={1}>
                    <text {...dimAttrs}>No active ABG run</text>
                </box>
            }
        >
            {(() => {
                const state = props.state;
                const graphId = state.focusedGraphId ?? state.activeGraphId ?? '(no graph)';
                const childGraphs = [...state.graphs.values()]
                    .filter((summary) => summary.parentGraphId === graphId)
                    .sort((left, right) => left.graphId.localeCompare(right.graphId));
                const rendered = visual();
                if (rendered === undefined) {
                    return (
                        <box flexDirection="column" marginTop={1}>
                            <text {...dimAttrs}>No active ABG run</text>
                        </box>
                    );
                }
                const bounds = graphBounds();
                const maxPanX = Math.max(0, rendered.fullWidth - bounds.maxWidth);
                const maxPanY = Math.max(0, rendered.fullHeight - bounds.maxHeight);
                const panHint =
                    rendered.pannable || maxPanX > 0 || maxPanY > 0
                        ? `  pan ${rendered.offsetX}/${maxPanX}×${rendered.offsetY}/${maxPanY}  ←→↑↓`
                        : '';
                return (
                    <box flexDirection="column" marginTop={1}>
                        <box flexDirection="row">
                            <text {...boldAttrs}>{sanitizeAbgDisplayText(graphId)}</text>
                            {panHint.length > 0 ? <text {...dimAttrs}>{panHint}</text> : null}
                        </box>
                        <box marginLeft={2} flexDirection="column">
                            <For each={rendered.rows}>{(row) => renderVisualRow(row, spinnerGlyph())}</For>
                        </box>
                        {childGraphs.length > 0 ? (
                            <box marginTop={1} flexDirection="column">
                                <text {...boldAttrs} {...dimAttrs}>
                                    Child Graphs ({childGraphs.length})
                                </text>
                                <For each={childGraphs}>
                                    {(child) => {
                                        const themeFg = graphStatusTheme(child.status).foreground;
                                        const childFg = themeFg !== STATUS_FG_GRAY ? themeFg : undefined;
                                        return (
                                            <box flexDirection="row" marginLeft={2}>
                                                <text {...dimAttrs}>↳</text>
                                                <text> </text>
                                                <text {...(childFg !== undefined ? { fg: childFg } : dimAttrs)}>
                                                    {child.status}
                                                </text>
                                                <text> </text>
                                                <text>{truncate(child.graphId, 30)}</text>
                                                <text {...dimAttrs}> events={child.eventCount}</text>
                                            </box>
                                        );
                                    }}
                                </For>
                            </box>
                        ) : null}
                    </box>
                );
            })()}
        </Show>
    );
}
