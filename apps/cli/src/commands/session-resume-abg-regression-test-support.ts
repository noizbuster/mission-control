import type { AgentEvent, GraphCheckpoint, WorkflowSpec } from '@mission-control/protocol';
import type { ChatOutput } from './interactive-chat-io';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI_RESUME_REGRESSION_TIMESTAMP = '2026-07-20T12:00:00.000Z';
export const CLI_RESUME_REGRESSION_SESSION_ID = 'session_cli_resume_regression';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_RESUME_PATH_SOURCES = [
    join(HERE, 'session-attach-projection.ts'),
    join(HERE, 'work-resume-decision.ts'),
    join(HERE, 'interactive-workflow-resume-actions.ts'),
    join(HERE, 'interactive-workflow-state.ts'),
] as const;

export function baseEvent(type: AgentEvent['type'], overrides: Partial<AgentEvent> = {}): AgentEvent {
    return {
        type,
        timestamp: CLI_RESUME_REGRESSION_TIMESTAMP,
        sessionId: CLI_RESUME_REGRESSION_SESSION_ID,
        message: type,
        ...overrides,
    };
}

export function interruptedEvents(checkpoint: GraphCheckpoint, runId: string): AgentEvent[] {
    return [
        baseEvent('graph.started', { abg: { graphId: checkpoint.graphId } }),
        baseEvent('node.started', { abg: { graphId: checkpoint.graphId, nodeId: 'start' } }),
        baseEvent('node.completed', { abg: { graphId: checkpoint.graphId, nodeId: 'start' } }),
        baseEvent('graph.checkpoint', {
            abg: { graphId: checkpoint.graphId, checkpoint },
            run: { runId },
        }),
        baseEvent('run.interrupted', {
            run: { runId, state: 'interrupted', reason: 'provider_aborted' },
        }),
    ];
}

export function makeCheckpoint(input: {
    readonly graphId?: string;
    readonly sessionRunId: string;
    readonly queuedNodeIds: readonly string[];
    readonly completedNodeIds: readonly string[];
    readonly workflowName?: string;
}): GraphCheckpoint {
    return {
        schemaVersion: 1,
        graphId: input.graphId ?? 'graph-main',
        sessionRunId: input.sessionRunId,
        ...(input.workflowName !== undefined ? { workflowName: input.workflowName } : {}),
        reason: 'interrupt',
        queuedNodeIds: [...input.queuedNodeIds],
        completedNodeIds: [...input.completedNodeIds],
        nodeStatuses: Object.fromEntries(input.completedNodeIds.map((nodeId) => [nodeId, 'succeeded' as const])),
        attemptsByNodeId: Object.fromEntries(input.completedNodeIds.map((nodeId) => [nodeId, 1])),
        consecutiveFailuresByNodeId: {},
        consecutiveToolFailuresByNodeId: {},
        totalNodeRuns: input.completedNodeIds.length,
        budgetExtensionsUsed: 0,
        maxNodeRuns: 64,
        blackboardEntries: {},
        activeParallelParentIds: [],
        createdAt: CLI_RESUME_REGRESSION_TIMESTAMP,
    };
}

export function workflowSpec(name: string, graphId: string): WorkflowSpec {
    return {
        name,
        graph: {
            id: graphId,
            entryNodeId: 'entry',
            nodes: [{ id: 'entry', kind: 'llm' }],
            edges: [],
            rules: [],
            policies: [],
        },
    };
}

export function createChatOutput(): ChatOutput & {
    readonly sticky: { value: string | null };
    readonly writes: string[];
} {
    const sticky = { value: null as string | null };
    const writes: string[] = [];
    return {
        writes,
        sticky,
        write: (text) => {
            writes.push(text);
        },
        setStickyNotice: (message) => {
            sticky.value = message;
        },
    };
}

export function readCliResumePathSourceTexts(): readonly { readonly sourcePath: string; readonly source: string }[] {
    return CLI_RESUME_PATH_SOURCES.map((sourcePath) => ({ sourcePath, source: readFileSync(sourcePath, 'utf8') }));
}
