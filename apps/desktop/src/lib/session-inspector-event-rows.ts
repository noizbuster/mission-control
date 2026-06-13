import type {
    AbgNodeModelOptions,
    AbgNodeSnapshot,
    AgentEvent,
    DiffHunk,
    ModelProviderSelection,
} from '@mission-control/protocol';
import { redactDisplayLines, redactDisplayText } from './redaction.js';

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
    readonly eventType: AgentEvent['type'];
    readonly timestamp: string;
    readonly filePath: string;
    readonly changeKind: string;
    readonly text: string;
};

export type CommandRow = {
    readonly key: string;
    readonly eventType: AgentEvent['type'];
    readonly timestamp: string;
    readonly message: string;
    readonly command: string;
    readonly status: string;
    readonly exit: string;
    readonly cwd: string;
};

export function projectTimelineRows(events: readonly AgentEvent[]): readonly TimelineRow[] {
    return events.map((event, index) => ({
        key: `${event.type}-${event.timestamp}-${index}`,
        type: event.type,
        timestamp: event.timestamp,
        taskId: event.taskId ?? '',
        message: redactDisplayText(event.message ?? ''),
        graphId: event.abg?.graphId ?? '',
        nodeId: event.abg?.nodeId ?? '',
        signal: event.abg?.signalType ?? '',
        model: formatEventModel(event),
    }));
}

export function projectGraphPanels(events: readonly AgentEvent[]): readonly GraphPanel[] {
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

export function projectBranchRows(events: readonly AgentEvent[]): readonly BranchRow[] {
    return events.flatMap((event, index) => {
        const transcript = event.transcript;
        if (transcript === undefined) {
            return [];
        }
        return [
            {
                key: `${transcript.messageId ?? ''}-${index}`,
                messageId: transcript.messageId ?? '',
                parentMessageId: transcript.parentMessageId ?? '',
                delivery: transcript.delivery ?? '',
                visibility: transcript.visibility ?? '',
                message: redactDisplayText(event.message ?? ''),
            },
        ];
    });
}

export function projectPatchRows(events: readonly AgentEvent[]): readonly PatchRow[] {
    return events.flatMap((event, index) =>
        (event.diffFiles ?? []).map((file, fileIndex) => ({
            key: `${event.timestamp}-${index}-${fileIndex}`,
            eventType: event.type,
            timestamp: event.timestamp,
            filePath: redactDisplayText(file.filePath),
            changeKind: file.changeKind,
            text: patchText(file.hunks),
        })),
    );
}

export function projectCommandRows(events: readonly AgentEvent[]): readonly CommandRow[] {
    return events.flatMap((event, index) => {
        if (event.command === undefined) {
            return [];
        }
        return [
            {
                key: `${event.timestamp}-${index}`,
                eventType: event.type,
                timestamp: event.timestamp,
                message: redactDisplayText(event.message ?? ''),
                command: redactDisplayText(event.command.command.join(' ')),
                status: event.command.status,
                exit: String(event.command.exitCode ?? event.command.signal ?? ''),
                cwd: redactDisplayText(event.command.cwd),
            },
        ];
    });
}

function patchText(hunks: readonly DiffHunk[]): string {
    const lines = hunks.flatMap((hunk: DiffHunk) => hunk.lines);
    const redactedLines = redactDisplayLines(lines.map((line) => line.content));
    return lines.map((line, index) => `${prefixForDiffLine(line.kind)}${redactedLines[index] ?? ''}`).join('\n');
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

function graphStatus(eventType: AgentEvent['type'], current: string | undefined): string {
    switch (eventType) {
        case 'graph.completed':
            return 'completed';
        case 'graph.failed':
            return 'failed';
        case 'graph.cancelled':
            return 'cancelled';
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
