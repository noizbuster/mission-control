/** @jsxImportSource @opentui/react */

import type { AgentRef, BackgroundJobHandle } from '@mission-control/core';
import { MAIN_AGENT_ID } from '@mission-control/core';
import { TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import type * as React from 'react';
import { useCallback, useSyncExternalStore } from 'react';
import type { ChatStore, MissionPanelTab } from '../commands/chat-store.js';
import { loadMissionPanelRows } from '../commands/interactive-chat-actions.js';
import type { MissionControlServices } from '../commands/mission-control-services.js';
import { buildAgentPanelRows, buildJobPanelRows } from './mission-panel-rows.js';
import { renderAgentsTab, renderJobsTab, renderRunsTab } from './mission-panel-tabs.js';
import { OverlayFrame } from './OverlayFrame.js';

const MISSION_PANEL_TABS: readonly MissionPanelTab[] = ['runs', 'jobs', 'agents', 'drain', 'continue'];

const TAB_LABELS: Record<MissionPanelTab, string> = {
    runs: 'Runs',
    jobs: 'Jobs',
    agents: 'Agents',
    drain: 'Drain',
    continue: 'Continue',
};

const PLACEHOLDER_COPY: Record<Exclude<MissionPanelTab, 'runs' | 'jobs' | 'agents'>, string> = {
    drain: 'Drain tab: RunCoordinatorV2 drain-lane state (todo 11).',
    continue: 'Continue tab: session-spanning continuation runtime (todo 11).',
};

const NO_JOBS: readonly BackgroundJobHandle[] = [];
const NO_AGENTS: readonly AgentRef[] = [];

export type MissionPanelOverlayProps = {
    readonly store: ChatStore;
    readonly workspaceRoot: string | undefined;
    readonly services?: MissionControlServices;
};

export function MissionPanelOverlay({ store, workspaceRoot, services }: MissionPanelOverlayProps): React.ReactNode {
    const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);
    const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
    const snapshot = useSyncExternalStore(subscribe, getSnapshot);
    const panel = snapshot.missionPanel;

    const jobs = services !== undefined ? services.getJobManager().listJobs() : NO_JOBS;
    const jobRows = buildJobPanelRows(jobs);
    const agents = services !== undefined ? services.getRuntimeRegistry().listVisibleTo(MAIN_AGENT_ID) : NO_AGENTS;
    const agentRows = buildAgentPanelRows(agents);

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
        // Arrow/j/k navigation is shared across runs/jobs/agents. Each tab
        // clamps against its own row count; the store cursor is reused.
        if (panel.activeTab !== 'runs' && panel.activeTab !== 'jobs' && panel.activeTab !== 'agents') return;
        const navCount =
            panel.activeTab === 'runs'
                ? panel.rows.length
                : panel.activeTab === 'jobs'
                  ? jobRows.length
                  : agentRows.length;
        if (navCount === 0) return;
        if (key.name === 'up' || key.name === 'k') {
            key.preventDefault();
            store.navigateMissionPanel(-1, navCount);
            return;
        }
        if (key.name === 'down' || key.name === 'j') {
            key.preventDefault();
            store.navigateMissionPanel(1, navCount);
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
                renderRunsTab(panel.selectedIndex, panel.rows)
            ) : panel.activeTab === 'jobs' ? (
                renderJobsTab(panel.selectedIndex, jobRows)
            ) : panel.activeTab === 'agents' ? (
                renderAgentsTab(panel.selectedIndex, agentRows)
            ) : (
                <box marginTop={1}>
                    <text attributes={TextAttributes.DIM}>{PLACEHOLDER_COPY[panel.activeTab]}</text>
                </box>
            )}
        </OverlayFrame>
    );
}
