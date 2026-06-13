import type { DesktopSessionDiagnostic, DesktopSessionLog, DesktopSessionSummary } from './agent-client.js';
import { redactMessageFields } from './redaction.js';
import {
    type BranchRow,
    type CommandRow,
    type GraphPanel,
    type PatchRow,
    projectBranchRows,
    projectCommandRows,
    projectGraphPanels,
    projectPatchRows,
    projectTimelineRows,
    type TimelineRow,
} from './session-inspector-event-rows.js';
import {
    type ApprovalRow,
    type CodingStepRow,
    projectReplayInspectorRows,
    type ToolOutcomeRow,
} from './session-inspector-replay.js';
import {
    projectSessionDetail,
    type SessionListRow,
    type SessionStatsPanel,
    type SessionTreePanel,
} from './session-inspector-session-detail.js';

export type SessionInspectorProjection = {
    readonly sessions: readonly SessionListRow[];
    readonly selectedLog: DesktopSessionLog | undefined;
    readonly diagnostics: readonly DesktopSessionDiagnostic[];
    readonly timeline: readonly TimelineRow[];
    readonly graphs: readonly GraphPanel[];
    readonly branches: readonly BranchRow[];
    readonly approvals: readonly ApprovalRow[];
    readonly patches: readonly PatchRow[];
    readonly commands: readonly CommandRow[];
    readonly codingSteps: readonly CodingStepRow[];
    readonly toolOutcomes: readonly ToolOutcomeRow[];
    readonly sessionTree: SessionTreePanel | undefined;
    readonly stats: SessionStatsPanel | undefined;
};

export function projectSessionInspector(input: {
    readonly sessions: readonly DesktopSessionSummary[];
    readonly selectedLog: DesktopSessionLog | undefined;
}): SessionInspectorProjection {
    const events = input.selectedLog?.envelopes.map((envelope) => envelope.event) ?? [];
    const replayRows = projectReplayInspectorRows(input.selectedLog);
    const detail = projectSessionDetail(input);
    return {
        sessions: detail.sessionList,
        selectedLog: input.selectedLog,
        diagnostics: redactMessageFields([...(input.selectedLog?.diagnostics ?? []), ...replayRows.diagnostics]),
        timeline: projectTimelineRows(events),
        graphs: projectGraphPanels(events),
        branches: projectBranchRows(events),
        approvals: replayRows.approvals,
        patches: projectPatchRows(events),
        commands: projectCommandRows(events),
        codingSteps: replayRows.codingSteps,
        toolOutcomes: replayRows.toolOutcomes,
        sessionTree: detail.sessionTree,
        stats: detail.stats,
    };
}
