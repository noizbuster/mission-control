import {
    AgentRuntime,
    createAllowPermissionDecision,
    createMission,
    ensureOmoDirs,
    materializeMission,
    resolveOmoRoot,
    startRun,
} from '@mission-control/core';
import type { ModelProviderSelection, WorkflowSpec } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatStore, type MissionPanelRow } from './chat-store.js';
import type { CodingActionContext } from './interactive-chat-actions.js';
import { loadMissionPanelRows, runChatAction } from './interactive-chat-actions.js';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const currentSelection: ModelProviderSelection = { providerID: 'local', modelID: 'local-echo' };
const tempRoots: string[] = [];

afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('/mission command action', () => {
    it('opens the mission panel overlay via the store when useTui and openMissionPanel are set', async () => {
        const workspace = await makeWorkspace();
        await seedRunRecord(workspace, 'planner');

        let openedRows: readonly MissionPanelRow[] | undefined;
        const runtime = await makeStartedRuntime();

        await runChatAction(
            runtime,
            createOutput(),
            { kind: 'mission' },
            currentSelection,
            async () => undefined,
            [],
            makeCodingContext(workspace, { openMissionPanel: (rows) => (openedRows = rows) }),
        );

        expect(openedRows).toBeDefined();
        expect(openedRows!.length).toBeGreaterThanOrEqual(1);
        expect(openedRows!.some((row) => row.label.startsWith('planner'))).toBe(true);
    });

    it('passes an empty row list when the workspace has no .omo root', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'no-omo-'));
        tempRoots.push(workspace);
        let openedRows: readonly MissionPanelRow[] | undefined;
        const runtime = await makeStartedRuntime();

        await runChatAction(
            runtime,
            createOutput(),
            { kind: 'mission' },
            currentSelection,
            async () => undefined,
            [],
            makeCodingContext(workspace, { openMissionPanel: (rows) => (openedRows = rows) }),
        );

        expect(openedRows).toEqual([]);
    });

    it('writes a fallback message when useTui is false', async () => {
        const workspace = await makeWorkspace();
        const output = createOutput();
        const runtime = await makeStartedRuntime();

        await runChatAction(
            runtime,
            output,
            { kind: 'mission' },
            currentSelection,
            async () => undefined,
            [],
            makeCodingContext(workspace, { useTui: false }),
        );

        expect(output.getOutput()).toContain('/mission requires the interactive TUI overlay');
    });
});

describe('loadMissionPanelRows', () => {
    it('builds one row per Run labelled with the parent Mission name', async () => {
        const workspace = await makeWorkspace();
        await seedRunRecord(workspace, 'planner');

        const rows = await loadMissionPanelRows(workspace);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.label).toBe('planner #1');
        expect(rows[0]?.status).toBe('running');
        expect(rows[0]?.id).toBeDefined();
    });

    it('surfaces a Mission with no Runs as a single row', async () => {
        const workspace = await makeWorkspace();
        const omoRoot = await resolveOmoRoot(workspace);
        await createMission(omoRoot, materializeMission(makeWorkflowSpec('runner')));

        const rows = await loadMissionPanelRows(workspace);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.label).toBe('runner');
    });

    it('returns an empty array when the workspace has no .omo root', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'no-omo-rows-'));
        tempRoots.push(workspace);

        const rows = await loadMissionPanelRows(workspace);

        expect(rows).toEqual([]);
    });

    it('returns an empty array when workspaceRoot is undefined', async () => {
        const rows = await loadMissionPanelRows(undefined);

        expect(rows).toEqual([]);
    });

    it('produces one row per Run under a single Mission with unique row ids', async () => {
        const workspace = await makeWorkspace();
        const omoRoot = await resolveOmoRoot(workspace);
        const mission = materializeMission(makeWorkflowSpec('planner'));
        await createMission(omoRoot, mission);
        await startRun(omoRoot, mission.id, 'first');
        await startRun(omoRoot, mission.id, 'second');

        const rows = await loadMissionPanelRows(workspace);

        expect(rows).toHaveLength(2);
        const firstId = rows[0]?.id;
        const secondId = rows[1]?.id;
        expect(firstId).toBeDefined();
        expect(secondId).toBeDefined();
        expect(firstId).not.toBe(secondId);
    });

    it('produces rows for multiple Missions in list order', async () => {
        const workspace = await makeWorkspace();
        const omoRoot = await resolveOmoRoot(workspace);
        const missionWithRun = materializeMission(makeWorkflowSpec('planner'));
        const missionWithoutRun = materializeMission(makeWorkflowSpec('runner'));
        await createMission(omoRoot, missionWithRun);
        await createMission(omoRoot, missionWithoutRun);
        await startRun(omoRoot, missionWithRun.id, 'plan');

        const rows = await loadMissionPanelRows(workspace);

        expect(rows).toHaveLength(2);
        expect(rows[0]?.label).toBe('planner #1');
        expect(rows[1]?.label).toBe('runner');
    });
});

describe('ChatStore mission-panel slice', () => {
    it('showMissionPanel activates the overlay and seeds rows', () => {
        const store = createChatStore();
        const rows: MissionPanelRow[] = [
            { id: 'r1', label: 'planner #1', status: 'running' },
            { id: 'r2', label: 'runner #1', status: 'completed' },
        ];

        store.showMissionPanel(rows);

        const snap = store.getSnapshot();
        expect(snap.overlayMode).toBe('mission-panel');
        expect(snap.missionPanel.active).toBe(true);
        expect(snap.missionPanel.rows).toBe(rows);
        expect(snap.missionPanel.count).toBe(2);
        expect(snap.missionPanel.activeTab).toBe('runs');
    });

    it('hideMissionPanel deactivates the overlay and resets the mode', () => {
        const store = createChatStore();
        store.showMissionPanel([{ id: 'r1', label: 'x' }]);

        store.hideMissionPanel();

        const snap = store.getSnapshot();
        expect(snap.overlayMode).toBe('none');
        expect(snap.missionPanel.active).toBe(false);
    });

    it('navigateMissionPanel clamps within the row bounds', () => {
        const store = createChatStore();
        store.showMissionPanel([
            { id: 'r1', label: 'a' },
            { id: 'r2', label: 'b' },
            { id: 'r3', label: 'c' },
        ]);

        store.navigateMissionPanel(1);
        store.navigateMissionPanel(1);
        store.navigateMissionPanel(1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(2);

        store.navigateMissionPanel(-5);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(0);
    });

    it('navigateMissionPanel is a no-op when there are no rows', () => {
        const store = createChatStore();
        store.showMissionPanel([]);

        store.navigateMissionPanel(1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(0);
    });

    it('setMissionPanelTab switches the active tab', () => {
        const store = createChatStore();
        store.showMissionPanel([{ id: 'r1', label: 'a' }]);

        store.setMissionPanelTab('jobs');
        expect(store.getSnapshot().missionPanel.activeTab).toBe('jobs');

        store.setMissionPanelTab('runs');
        expect(store.getSnapshot().missionPanel.activeTab).toBe('runs');
    });

    it('reloadMissions preserves the selection by id when the overlay is open', () => {
        const store = createChatStore();
        store.showMissionPanel([
            { id: 'r1', label: 'a' },
            { id: 'r2', label: 'b' },
            { id: 'r3', label: 'c' },
        ]);
        store.navigateMissionPanel(2);

        store.reloadMissions([
            { id: 'r1', label: 'a' },
            { id: 'r3', label: 'c-updated' },
        ]);

        const snap = store.getSnapshot().missionPanel;
        expect(snap.rows.map((row) => row.id)).toEqual(['r1', 'r3']);
        expect(snap.selectedIndex).toBe(1);
        expect(snap.count).toBe(2);
    });

    it('reloadMissions is a no-op when the overlay is not open', () => {
        const store = createChatStore();
        store.showMissionPanel([{ id: 'r1', label: 'a' }]);
        store.hideMissionPanel();

        store.reloadMissions([{ id: 'r9', label: 'new' }]);

        expect(store.getSnapshot().missionPanel.rows).toEqual([{ id: 'r1', label: 'a' }]);
    });

    it('navigateMissionPanel on a single-row list is a no-op in both directions', () => {
        const store = createChatStore();
        store.showMissionPanel([{ id: 'r1', label: 'only' }]);

        store.navigateMissionPanel(1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(0);
        store.navigateMissionPanel(-1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(0);
    });

    it('reloadMissions transitioning to an empty list resets selectedIndex to 0', () => {
        const store = createChatStore();
        store.showMissionPanel([
            { id: 'r1', label: 'a' },
            { id: 'r2', label: 'b' },
        ]);
        store.navigateMissionPanel(1);
        expect(store.getSnapshot().missionPanel.selectedIndex).toBe(1);

        store.reloadMissions([]);

        const snap = store.getSnapshot().missionPanel;
        expect(snap.rows).toEqual([]);
        expect(snap.count).toBe(0);
        expect(snap.selectedIndex).toBe(0);
    });
});

async function makeStartedRuntime(): Promise<AgentRuntime> {
    const runtime = new AgentRuntime({ permissionDecisionResolver: createAllowPermissionDecision });
    await runtime.start();
    return runtime;
}

async function makeWorkspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'mission-panel-'));
    await mkdir(join(root, '.omo'), { recursive: true });
    tempRoots.push(root);
    return root;
}

async function seedRunRecord(workspace: string, workflowName: string): Promise<void> {
    const omoRoot = await resolveOmoRoot(workspace);
    await ensureOmoDirs(omoRoot);
    const mission = materializeMission(makeWorkflowSpec(workflowName));
    await createMission(omoRoot, mission);
    await startRun(omoRoot, mission.id, 'test prompt');
}

function makeWorkflowSpec(name: string): WorkflowSpec {
    return {
        name,
        graph: {
            id: `${name}-graph`,
            entryNodeId: 'entry',
            nodes: [{ id: 'entry', kind: 'llm' }],
            edges: [],
            rules: [],
            policies: [],
        },
    };
}

function makeCodingContext(
    workspaceRoot: string,
    overrides: {
        readonly useTui?: boolean;
        readonly openMissionPanel?: (rows: readonly MissionPanelRow[]) => void;
    },
): CodingActionContext {
    return {
        activeTurn: undefined,
        useTui: overrides.useTui ?? true,
        commandExecutor: undefined,
        emitEvent: undefined,
        nextTurnId: () => 'turn_test',
        observeStoredEvent: undefined,
        provider: undefined,
        sessionId: undefined,
        sessionStore: undefined,
        workspaceRoot,
        ...(overrides.openMissionPanel !== undefined ? { openMissionPanel: overrides.openMissionPanel } : {}),
    };
}

function createOutput() {
    const chunks: string[] = [];
    return {
        write: (text: string) => {
            chunks.push(text);
        },
        getOutput: () => chunks.join(''),
    };
}
