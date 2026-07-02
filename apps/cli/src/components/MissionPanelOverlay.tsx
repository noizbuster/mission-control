/** @jsxImportSource @opentui/react */
import { TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import type * as React from 'react';
import { useCallback, useSyncExternalStore } from 'react';
import type { ChatStore, MissionPanelTab } from '../commands/chat-store.js';
import { loadMissionPanelRows } from '../commands/interactive-chat-actions.js';
import { OverlayFrame } from './OverlayFrame.js';
import { SELECTED_BG } from './overlay-theme.js';

const MISSION_PANEL_MAX_VISIBLE = 12;

const MISSION_PANEL_TABS: readonly MissionPanelTab[] = ['runs', 'jobs', 'agents', 'drain', 'continue'];

const TAB_LABELS: Record<MissionPanelTab, string> = {
    runs: 'Runs',
    jobs: 'Jobs',
    agents: 'Agents',
    drain: 'Drain',
    continue: 'Continue',
};

const PLACEHOLDER_COPY: Record<Exclude<MissionPanelTab, 'runs'>, string> = {
    jobs: 'Jobs tab: async child-agent jobs (todo 9).',
    agents: 'Agents tab: live runtime-agent registry (todo 9).',
    drain: 'Drain tab: RunCoordinatorV2 drain-lane state (todo 11).',
    continue: 'Continue tab: session-spanning continuation runtime (todo 11).',
};

export type MissionPanelOverlayProps = {
    readonly store: ChatStore;
    readonly workspaceRoot: string | undefined;
};

export function MissionPanelOverlay({ store, workspaceRoot }: MissionPanelOverlayProps): React.ReactNode {
    const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);
    const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
    const snapshot = useSyncExternalStore(subscribe, getSnapshot);
    const panel = snapshot.missionPanel;

    const cycleTab = useCallback(
        (delta: number): void => {
            const idx = MISSION_PANEL_TABS.indexOf(panel.activeTab);
            const next = MISSION_PANEL_TABS[(idx + delta + MISSION_PANEL_TABS.length) % MISSION_PANEL_TABS.length];
            if (next !== undefined) {
                store.setMissionPanelTab(next);
            }
        },
        [panel.activeTab, store],
    );

    const reload = useCallback((): void => {
        if (workspaceRoot === undefined) return;
        void (async () => {
            const rows = await loadMissionPanelRows(workspaceRoot);
            store.reloadMissions(rows);
        })();
    }, [workspaceRoot, store]);

    useKeyboard((key) => {
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
            store.hideMissionPanel();
            return;
        }
        if (key.name === 'tab') {
            key.preventDefault();
            cycleTab(key.shift ? -1 : 1);
            return;
        }
        if (key.name === ']') {
            key.preventDefault();
            cycleTab(1);
            return;
        }
        if (key.name === '[') {
            key.preventDefault();
            cycleTab(-1);
            return;
        }
        if (key.ctrl && key.name === 'r') {
            reload();
            return;
        }
        if (panel.activeTab !== 'runs') return;
        if (key.name === 'up' || key.name === 'k') {
            key.preventDefault();
            store.navigateMissionPanel(-1);
            return;
        }
        if (key.name === 'down' || key.name === 'j') {
            key.preventDefault();
            store.navigateMissionPanel(1);
            return;
        }
    });

    return (
        <OverlayFrame
            variant="modal"
            title="Mission Control"
            footer="Tab/[ ] cycle · Up/Dn navigate · Ctrl+R reload · Esc close"
        >
            <box flexDirection="row">
                {MISSION_PANEL_TABS.map((tab) => {
                    const active = tab === panel.activeTab;
                    return (
                        <text key={tab} {...(active ? { attributes: TextAttributes.BOLD } : {})}>
                            {`${active ? '[' : ' '} ${TAB_LABELS[tab]} ${active ? ']' : ' '}`}
                        </text>
                    );
                })}
            </box>
            {panel.activeTab === 'runs' ? (
                renderRunsTab(panel, snapshot.missionPanel.rows)
            ) : (
                <box marginTop={1}>
                    <text attributes={TextAttributes.DIM}>{PLACEHOLDER_COPY[panel.activeTab]}</text>
                </box>
            )}
        </OverlayFrame>
    );
}

function renderRunsTab(
    panel: { readonly selectedIndex: number },
    rows: readonly {
        readonly id: string;
        readonly label: string;
        readonly status?: string;
        readonly detail?: string;
    }[],
): React.ReactNode {
    if (rows.length === 0) {
        return (
            <box marginTop={1}>
                <text attributes={TextAttributes.DIM}>No missions or runs recorded yet.</text>
            </box>
        );
    }
    const totalCount = rows.length;
    const visibleLimit = Math.min(MISSION_PANEL_MAX_VISIBLE, totalCount);
    const selectedIndex = Math.min(Math.max(panel.selectedIndex, 0), totalCount - 1);
    const startIndex =
        totalCount <= visibleLimit
            ? 0
            : Math.min(Math.max(selectedIndex - Math.floor(visibleLimit / 2), 0), totalCount - visibleLimit);
    const visibleRows = rows.slice(startIndex, startIndex + visibleLimit);
    return (
        <box flexDirection="column" marginTop={1}>
            <text attributes={TextAttributes.DIM}>
                {`${startIndex + 1}-${startIndex + visibleRows.length} of ${totalCount}`}
            </text>
            {visibleRows.map((row, index) => {
                const globalIndex = startIndex + index;
                const isSelected = globalIndex === selectedIndex;
                const status = row.status ?? '';
                return (
                    <box key={row.id} flexDirection="row" {...(isSelected ? { bg: SELECTED_BG } : {})}>
                        <text>
                            {isSelected ? '> ' : '  '}
                            {row.label}
                        </text>
                        {status.length > 0 ? <text fg={statusColor(status)}>{` [${status}]`}</text> : null}
                        {row.detail !== undefined ? (
                            <text attributes={TextAttributes.DIM}>{` ${row.detail}`}</text>
                        ) : null}
                    </box>
                );
            })}
        </box>
    );
}

function statusColor(status: string): string {
    switch (status) {
        case 'completed':
            return '#26d926';
        case 'failed':
        case 'cancelled':
            return '#ff6b6b';
        case 'running':
            return '#00ffff';
        case 'blocked':
        case 'pending':
            return '#ffaa00';
        default:
            return '#aaaaaa';
    }
}
