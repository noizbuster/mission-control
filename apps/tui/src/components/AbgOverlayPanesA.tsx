/** @jsxImportSource @opentui/solid */

import { truncateTerminalText } from '@mission-control/tui';
import { For, type JSX, Show } from 'solid-js';
import type { TerminalViewport } from '../platform/terminal-viewport';
import type { AbgOverlayState } from '../state/abg-overlay-state';
import { graphStatusTheme, nodeStatusTheme, STATUS_FG_GRAY } from './abg-status-theme';
import { useSpinnerFrame } from './spinner';
import {
    renderVisualGraph,
    type VisualGraphEdge,
    type VisualGraphNode,
    type VisualGraphRow,
    visualGraphBoundsForViewport,
} from './visual-graph';

export interface PaneProps {
    readonly state: AbgOverlayState;
    readonly modelLabel: string;
}

export type GraphPaneProps = PaneProps & {
    readonly viewport: TerminalViewport;
};

const dimAttrs = { dim: true };
const boldAttrs = { bold: true };

function truncate(text: string, max: number): string {
    return truncateTerminalText(text, max, '\u2026');
}

function formatCostSummary(state: AbgOverlayState): string {
    const cost = state.costCents !== undefined ? `$${(state.costCents / 100).toFixed(2)}` : '$0.00';
    return `${cost} / ${state.inputTokens} in / ${state.outputTokens} out`;
}

function isEmptyState(state: AbgOverlayState): boolean {
    return (
        state.activeGraphId === undefined ||
        state.graphStatus === undefined ||
        (state.nodes.size === 0 && state.recentEvents.length === 0)
    );
}

const cyanFg = '#00ffff';
const yellowFg = '#ffff00';
const redFg = '#ff0000';
const focusedStyle = { fg: cyanFg, bold: true };

export function OverviewPane({ state, modelLabel }: PaneProps): JSX.Element {
    if (isEmptyState(state)) {
        return (
            <box flexDirection="column" marginTop={1}>
                <text {...dimAttrs}>No active ABG run</text>
            </box>
        );
    }

    const graphId = state.focusedGraphId ?? state.activeGraphId ?? '(no graph)';
    const statusFgVal =
        state.graphStatus !== undefined ? graphStatusTheme(state.graphStatus).foreground : STATUS_FG_GRAY;
    const statusText = state.graphStatus ?? 'idle';

    const liveOutputLines = state.lastLiveDelta.split('\n').slice(-8);
    const knownGraphs = [...state.graphs.values()].sort((left, right) => left.graphId.localeCompare(right.graphId));

    return (
        <box flexDirection="column" marginTop={1}>
            <box flexDirection="row">
                <text {...boldAttrs}>{truncate(graphId, 20)}</text>
                <text> </text>
                <text {...(statusFgVal !== undefined ? { fg: statusFgVal } : {})} {...boldAttrs}>
                    [{statusText}]
                </text>
                <text> </text>
                <text {...dimAttrs}>{state.runState}</text>
                <text> </text>
                <text {...dimAttrs}>{modelLabel}</text>
                <text> </text>
                <text {...dimAttrs}>sidecar:{state.nativeSidecarStatus || 'unknown'}</text>
                <text> </text>
                <text {...dimAttrs}>{formatCostSummary(state)}</text>
            </box>
            {knownGraphs.length > 1 ? (
                <box marginTop={1} flexDirection="column">
                    <box flexDirection="row">
                        <text {...boldAttrs}>{`Graphs (${knownGraphs.length})  `}</text>
                        <text {...dimAttrs}>press 'g' to cycle focus</text>
                    </box>
                    <For each={knownGraphs}>
                        {(summary) => {
                            const isFocused = summary.graphId === state.focusedGraphId;
                            const themeFg = graphStatusTheme(summary.status).foreground;
                            const graphFg = themeFg !== STATUS_FG_GRAY ? themeFg : undefined;
                            return (
                                <box flexDirection="row">
                                    <text {...(isFocused ? focusedStyle : dimAttrs)}>{isFocused ? '▸ ' : '  '}</text>
                                    <text {...(graphFg !== undefined ? { fg: graphFg } : dimAttrs)}>
                                        {summary.status}
                                    </text>
                                    <text> </text>
                                    <text {...(isFocused ? boldAttrs : {})}>{truncate(summary.graphId, 30)}</text>
                                    <text {...dimAttrs}> events={summary.eventCount}</text>
                                    {summary.parentGraphId !== undefined ? (
                                        <text {...dimAttrs}> ← {truncate(summary.parentGraphId, 20)}</text>
                                    ) : null}
                                </box>
                            );
                        }}
                    </For>
                </box>
            ) : null}
            {state.lastError !== undefined ? (
                <box marginTop={1}>
                    <text {...(redFg !== undefined ? { fg: redFg } : {})}>Error: {state.lastError}</text>
                </box>
            ) : null}
            <box flexDirection="column" marginTop={1}>
                <text {...boldAttrs}>Live Output:</text>
                <For each={liveOutputLines}>{(line) => <text {...dimAttrs}>{line}</text>}</For>
            </box>
        </box>
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
        const nodes = [...state.nodes.entries()];
        const visualNodes: VisualGraphNode[] = nodes.map(([nodeId, status]) => ({
            nodeId,
            status,
            isActive: state.activeNodeIds.includes(nodeId),
        }));
        const visualEdges: VisualGraphEdge[] = state.graphEdges.map((edge) => ({
            from: edge.source,
            to: edge.target,
            ...(edge.condition !== undefined ? { label: edge.condition } : {}),
        }));
        const bounds = graphBounds();
        return renderVisualGraph({
            nodes: visualNodes,
            edges: visualEdges,
            maxWidth: bounds.maxWidth,
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
                return (
                    <box flexDirection="column" marginTop={1}>
                        <text {...boldAttrs}>{graphId}</text>
                        <scrollbox marginLeft={2} maxHeight={graphBounds().maxHeight} stickyScroll>
                            <For each={rendered.rows}>{(row) => renderVisualRow(row, spinnerGlyph())}</For>
                        </scrollbox>
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

export function NodesPane({ state }: PaneProps): JSX.Element {
    if (isEmptyState(state)) {
        return (
            <box flexDirection="column" marginTop={1}>
                <text {...dimAttrs}>No active ABG run</text>
            </box>
        );
    }

    const nodes = [...state.nodes.entries()];

    return (
        <box flexDirection="column" marginTop={1}>
            <box flexDirection="row">
                <text {...boldAttrs}>ID</text>
                <text> </text>
                <text {...boldAttrs}>Status</text>
            </box>
            {nodes.length === 0 ? (
                <box flexDirection="row">
                    <text {...dimAttrs}>(no nodes)</text>
                </box>
            ) : (
                <For each={nodes}>
                    {([nodeId, status]) => {
                        const nodeTheme = nodeStatusTheme(status);
                        const fg = nodeTheme.foreground;
                        const glyph = nodeTheme.glyph;
                        return (
                            <box flexDirection="row">
                                <text {...(fg !== undefined ? { fg } : dimAttrs)}>{glyph}</text>
                                <text> </text>
                                <text>{truncate(nodeId, 10)}</text>
                                <text> </text>
                                <text {...(fg !== undefined ? { fg } : dimAttrs)}>[{status}]</text>
                            </box>
                        );
                    }}
                </For>
            )}
        </box>
    );
}
