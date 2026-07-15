import {
    listMissions,
    listRunsForMission,
    normalizeMissionRunStoreLocation,
    type ObservabilityRedactor,
    resolveOmoRoot,
} from '@mission-control/core';
import type { Mission, ModelProviderSelection, Run } from '@mission-control/protocol';
import {
    createModelsOverlayRoleRows,
    createVariantChoices,
    type MissionPanelRow,
    type ModelChoice,
} from '@mission-control/tui/state';
import type { CodingActionContext } from './interactive-chat-action-context.js';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result.js';
import type { ChatOutput } from './interactive-chat-io.js';

export async function runModelsAction(
    chatOutput: ChatOutput,
    selection: ModelProviderSelection,
    modelChoices: readonly ModelChoice[],
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    if (!coding.useTui || coding.openModelsOverlay === undefined) {
        chatOutput.write('/models requires the interactive TUI overlay.\n');
        return actionResult(selection, coding.activeTurn);
    }
    const entries = modelChoices.flatMap((choice) => {
        const variants = createVariantChoices(choice.selection).map((variant) => variant.selection);
        return variants.length > 0 ? variants : [choice.selection];
    });
    if (entries.length === 0) {
        chatOutput.write('No models available. Configure a provider with /model first.\n');
        return actionResult(selection, coding.activeTurn);
    }
    const assignments = coding.authStore !== undefined ? await coding.authStore.getModelRoles() : {};
    coding.openModelsOverlay(entries, createModelsOverlayRoleRows(assignments, selection));
    return actionResult(selection, coding.activeTurn);
}

export async function runMissionAction(
    chatOutput: ChatOutput,
    selection: ModelProviderSelection,
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    if (!coding.useTui || coding.openMissionPanel === undefined) {
        chatOutput.write('/mission requires the interactive TUI overlay.\n');
        return actionResult(selection, coding.activeTurn);
    }
    coding.openMissionPanel(await loadMissionPanelRows(coding.workspaceRoot, coding.observabilityRedactor));
    return actionResult(selection, coding.activeTurn);
}

export async function loadMissionPanelRows(
    workspaceRoot: string | undefined,
    observabilityRedactor?: ObservabilityRedactor,
): Promise<MissionPanelRow[]> {
    if (workspaceRoot === undefined) return [];
    let omoRoot: string;
    try {
        omoRoot = await resolveOmoRoot(workspaceRoot);
    } catch {
        return [];
    }
    const location = normalizeMissionRunStoreLocation({
        omoRoot,
        ...(observabilityRedactor !== undefined ? { observabilityRedactor } : {}),
    });
    const missions = [...(await listMissions(location))].sort(compareMissions);
    const rows: MissionPanelRow[] = [];
    for (const mission of missions) {
        const runs = [...(await listRunsForMission(location, mission.id))].sort(compareRuns);
        if (runs.length === 0) {
            rows.push({
                id: mission.id,
                label: mission.name,
                status: mission.status,
                ...(mission.workflowName !== undefined ? { detail: `workflow: ${mission.workflowName}` } : {}),
            });
            continue;
        }
        for (const run of runs) {
            rows.push({
                id: run.id,
                label: `${mission.name} #${run.attempt}`,
                status: run.status,
                ...(run.startedAt !== undefined ? { detail: `started ${run.startedAt}` } : {}),
            });
        }
    }
    return rows;
}

function compareMissions(left: Mission, right: Mission): number {
    return (
        compareText(left.createdAt, right.createdAt) ||
        compareText(left.name, right.name) ||
        compareText(left.id, right.id)
    );
}

function compareRuns(left: Run, right: Run): number {
    return (
        compareText(left.startedAt ?? '', right.startedAt ?? '') ||
        compareText(left.prompt ?? '', right.prompt ?? '') ||
        compareText(left.id, right.id)
    );
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
