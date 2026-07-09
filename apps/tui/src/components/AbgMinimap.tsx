/** @jsxImportSource @opentui/solid */

import type { AbgNodeStatus } from '@mission-control/protocol';
import { createMemo, For, type JSX, Show } from 'solid-js';
import type { TerminalViewport } from '../platform/terminal-viewport.js';
import { useSolidStoreSelector } from '../platform/use-solid-store-selector.js';
import type { AbgOverlayStore } from '../state/abg-overlay-state.js';
import { nodeStatusTheme, STATUS_FG_GRAY } from './abg-status-theme.js';
import {
    renderVisualGraph,
    type VisualGraphEdge,
    type VisualGraphInput,
    type VisualGraphNode,
    type VisualGraphRow,
} from './visual-graph.js';

const MINIMAP_MAX_WIDTH = 22;
const MINIMAP_MAX_NODES = 6;
const PULSE_WINDOW_MS = 3000;

export interface AbgMinimapProps {
    readonly store: AbgOverlayStore;
    readonly viewport: TerminalViewport;
}

export function minimapMaxWidthForViewport(viewport: TerminalViewport): number {
    return Math.min(MINIMAP_MAX_WIDTH, Math.max(1, viewport.columns - 2));
}

function buildInput(
    nodes: ReadonlyMap<string, AbgNodeStatus>,
    edges: readonly { readonly source: string; readonly target: string; readonly condition?: string }[],
    activeNodeIds: readonly string[],
    activeGraphId: string | undefined,
    maxWidth: number,
): VisualGraphInput {
    const visualNodes: VisualGraphNode[] = [];
    for (const [nodeId, status] of nodes) {
        visualNodes.push({ nodeId, status, isActive: activeNodeIds.includes(nodeId) });
    }
    const visualEdges: VisualGraphEdge[] = edges.map((edge) => ({
        from: edge.source,
        to: edge.target,
        ...(edge.condition !== undefined ? { label: edge.condition } : {}),
    }));
    return {
        nodes: visualNodes,
        edges: visualEdges,
        ...(activeGraphId !== undefined ? { entryNodeId: activeGraphId } : {}),
        maxNodes: MINIMAP_MAX_NODES,
        maxWidth,
    };
}

function computeRecentStatuses(
    nodeChangedAtMs: ReadonlyMap<string, number>,
    nodes: ReadonlyMap<string, AbgNodeStatus>,
    now: number,
): Set<AbgNodeStatus> {
    const result = new Set<AbgNodeStatus>();
    for (const [nodeId, changedAt] of nodeChangedAtMs) {
        if (now - changedAt < PULSE_WINDOW_MS) {
            const status = nodes.get(nodeId);
            if (status !== undefined) result.add(status);
        }
    }
    return result;
}

function renderRow(row: VisualGraphRow, recentStatuses: Set<AbgNodeStatus>): JSX.Element {
    return (
        <box flexDirection="row" flexShrink={0}>
            <For each={row.segments}>
                {(segment) => {
                    const theme = segment.status !== undefined ? nodeStatusTheme(segment.status) : undefined;
                    const fg = theme?.foreground;
                    const isRecent = segment.status !== undefined && recentStatuses.has(segment.status);
                    return (
                        <text
                            {...(fg !== undefined ? { fg } : { fg: STATUS_FG_GRAY })}
                            {...(isRecent ? { bold: true } : {})}
                        >
                            {segment.text}
                        </text>
                    );
                }}
            </For>
        </box>
    );
}

export function AbgMinimap(props: AbgMinimapProps): JSX.Element {
    const state = useSolidStoreSelector(props.store, (snapshot) => snapshot);
    const rendered = createMemo(() => {
        const snap = state();
        if (snap.nodes.size === 0) return undefined;
        const input = buildInput(
            snap.nodes,
            snap.graphEdges,
            snap.activeNodeIds,
            snap.activeGraphId,
            minimapMaxWidthForViewport(props.viewport),
        );
        return {
            graph: renderVisualGraph(input),
            recentStatuses: computeRecentStatuses(snap.nodeChangedAtMs, snap.nodes, Date.now()),
        };
    });

    return (
        <Show when={rendered()}>
            {(view) => (
                <box
                    position="absolute"
                    top={0}
                    right={0}
                    flexDirection="column"
                    flexShrink={0}
                    borderStyle="single"
                    borderColor="#404040"
                >
                    <For each={view().graph.rows}>{(row) => renderRow(row, view().recentStatuses)}</For>
                </box>
            )}
        </Show>
    );
}
