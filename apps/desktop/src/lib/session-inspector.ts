import type {
    AbgNodeModelOptions,
    AbgNodeSnapshot,
    AgentEvent,
    DiffFile,
    DiffHunk,
    ModelProviderSelection,
} from '@mission-control/protocol';
import type { DesktopSessionDiagnostic, DesktopSessionLog, DesktopSessionSummary } from './agent-client.js';
import { redactDisplayLines, redactDisplayText, redactMessageFields } from './redaction.js';
import {
    type ApprovalRow,
    type CodingStepRow,
    projectReplayInspectorRows,
    type ToolOutcomeRow,
} from './session-inspector-replay.js';

export type TimelineRow = {
    readonly key: string;
    readonly type: AgentEvent['type'];
    readonly timestamp: string;
    readonly taskId: string;
    readonly message: string;
    readonly graphId: string;
    readonly nodeId: string;
    readonly signal: string;
    readonly model: string;
};

export type GraphPanel = {
    readonly graphId: string;
    readonly status: string;
    readonly nodes: readonly AbgNodeSnapshot[];
};

export type BranchRow = {
    readonly key: string;
    readonly messageId: string;
    readonly parentMessageId: string;
    readonly delivery: string;
    readonly visibility: string;
    readonly message: string;
};

export type PatchRow = {
    readonly key: string;
    readonly filePath: string;
    readonly changeKind: string;
    readonly text: string;
};

export type CommandRow = {
    readonly key: string;
    readonly command: string;
    readonly status: string;
    readonly exit: string;
    readonly cwd: string;
};

export type SessionInspectorProjection = {
    readonly sessions: readonly DesktopSessionSummary[];
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
};

export function projectSessionInspector(input: {
    readonly sessions: readonly DesktopSessionSummary[];
    readonly selectedLog: DesktopSessionLog | undefined;
}): SessionInspectorProjection {
    const events = input.selectedLog?.envelopes.map((envelope) => envelope.event) ?? [];
    const replayRows = projectReplayInspectorRows(input.selectedLog);
    return {
        sessions: input.sessions,
        selectedLog: input.selectedLog,
        diagnostics: redactMessageFields([...(input.selectedLog?.diagnostics ?? []), ...replayRows.diagnostics]),
        timeline: events.map((event, index) => timelineRow(event, index)),
        graphs: graphPanels(events),
        branches: events.flatMap((event, index) => branchRows(event, index)),
        approvals: replayRows.approvals,
        patches: events.flatMap((event, index) => patchRows(event, index)),
        commands: events.flatMap((event, index) => commandRows(event, index)),
        codingSteps: replayRows.codingSteps,
        toolOutcomes: replayRows.toolOutcomes,
    };
}

function timelineRow(event: AgentEvent, index: number): TimelineRow {
    return {
        key: `${event.type}-${event.timestamp}-${index}`,
        type: event.type,
        timestamp: event.timestamp,
        taskId: event.taskId ?? '',
        message: redactDisplayText(event.message ?? ''),
        graphId: event.abg?.graphId ?? '',
        nodeId: event.abg?.nodeId ?? '',
        signal: event.abg?.signalType ?? '',
        model: formatEventModel(event),
    };
}

function graphPanels(events: readonly AgentEvent[]): readonly GraphPanel[] {
    const graphs = new Map<string, Map<string, AbgNodeSnapshot>>();
    const statuses = new Map<string, string>();
    for (const event of events) {
        const graphId = event.abg?.graphId;
        if (graphId === undefined) {
            continue;
        }
        statuses.set(graphId, graphStatus(event.type, statuses.get(graphId)));
        if (event.abg?.nodeId !== undefined) {
            const nodes = graphs.get(graphId) ?? new Map<string, AbgNodeSnapshot>();
            nodes.set(event.abg.nodeId, {
                nodeId: event.abg.nodeId,
                status: nodeStatus(event.type),
                ...(event.abg.signalType !== undefined ? { lastSignalType: event.abg.signalType } : {}),
            });
            graphs.set(graphId, nodes);
        }
    }
    return [...graphs.entries()].map(([graphId, nodes]) => ({
        graphId,
        status: statuses.get(graphId) ?? 'running',
        nodes: [...nodes.values()],
    }));
}

function branchRows(event: AgentEvent, index: number): readonly BranchRow[] {
    const transcript = event.transcript;
    if (transcript === undefined) {
        return [];
    }
    const messageId = transcript.messageId ?? '';
    return [
        {
            key: `${messageId}-${index}`,
            messageId,
            parentMessageId: transcript.parentMessageId ?? '',
            delivery: transcript.delivery ?? '',
            visibility: transcript.visibility ?? '',
            message: redactDisplayText(event.message ?? ''),
        },
    ];
}

function patchRows(event: AgentEvent, index: number): readonly PatchRow[] {
    const diffFiles: readonly DiffFile[] = event.diffFiles ?? [];
    return diffFiles.map((file, fileIndex) => ({
        key: `${event.timestamp}-${index}-${fileIndex}`,
        filePath: redactDisplayText(file.filePath),
        changeKind: file.changeKind,
        text: patchText(file.hunks),
    }));
}

function patchText(hunks: readonly DiffHunk[]): string {
    const lines = hunks.flatMap((hunk: DiffHunk) => hunk.lines);
    const redactedLines = redactDisplayLines(lines.map((line) => line.content));
    return lines.map((line, index) => `${prefixForDiffLine(line.kind)}${redactedLines[index] ?? ''}`).join('\n');
}

function commandRows(event: AgentEvent, index: number): readonly CommandRow[] {
    const command = event.command;
    if (command === undefined) {
        return [];
    }
    return [
        {
            key: `${event.timestamp}-${index}`,
            command: redactDisplayText(command.command.join(' ')),
            status: command.status,
            exit: String(command.exitCode ?? command.signal ?? ''),
            cwd: redactDisplayText(command.cwd),
        },
    ];
}

function graphStatus(eventType: AgentEvent['type'], current: string | undefined): string {
    switch (eventType) {
        case 'graph.completed':
            return 'completed';
        case 'graph.failed':
            return 'failed';
        case 'graph.cancelled':
            return 'cancelled';
        case 'graph.started':
            return current ?? 'running';
        default:
            return current ?? 'running';
    }
}

function nodeStatus(eventType: AgentEvent['type']): AbgNodeSnapshot['status'] {
    switch (eventType) {
        case 'node.completed':
            return 'succeeded';
        case 'node.failed':
            return 'failed';
        case 'node.cancelled':
            return 'cancelled';
        case 'node.waiting':
            return 'blocked';
        default:
            return 'running';
    }
}

function prefixForDiffLine(kind: 'context' | 'added' | 'removed'): string {
    switch (kind) {
        case 'added':
            return '+';
        case 'removed':
            return '-';
        case 'context':
            return ' ';
        default:
            return assertNever(kind);
    }
}

function formatEventModel(event: AgentEvent): string {
    const abgModel = formatAbgModel(event.abg?.model);
    return abgModel.length > 0 ? abgModel : formatModelSelection(event.modelProviderSelection);
}

function formatModelSelection(modelProviderSelection: ModelProviderSelection | undefined): string {
    if (modelProviderSelection === undefined) {
        return '';
    }
    return `${modelProviderSelection.providerID}/${modelProviderSelection.modelID}`;
}

function formatAbgModel(model: AbgNodeModelOptions | undefined): string {
    if (model === undefined) {
        return '';
    }
    return `${model.providerID}/${model.modelID}${model.variantID !== undefined ? `/${model.variantID}` : ''}`;
}

function assertNever(value: never): never {
    throw new Error(`Unexpected diff line kind: ${String(value)}`);
}
