import type {
    AbgEmbeddedEvent,
    AbgGraphSpec,
    AbgNodeSpec,
    AbgSignal,
    AgentEvent,
    GraphCheckpoint,
    ModelProviderSelection,
} from '@mission-control/protocol';
import type { AbgNodeRunContext } from '../behavior/node-registry';
import { createAbgNodeRegistry } from '../behavior/node-registry';
import type { RunCoordinatorTurnContext } from './run-coordinator-types';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SESSION_RESUME_REGRESSION_NOW = '2026-07-20T00:00:00.000Z';
export const SESSION_RESUME_REGRESSION_SESSION_ID = 'session_resume_regression';
export const SESSION_RESUME_REGRESSION_MODEL: ModelProviderSelection = {
    providerID: 'local',
    modelID: 'local-echo',
};

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_SRC = join(HERE, '..');

const RESUME_PATH_SOURCES = [
    join(HERE, 'graph-coordinator-turn.ts'),
    join(HERE, 'graph-resume-state.ts'),
    join(HERE, 'run-coordinator-engine.ts'),
    join(HERE, 'run-coordinator-drain.ts'),
    join(HERE, 'run-coordinator-types.ts'),
    join(CORE_SRC, 'behavior', 'graph-coordinator-resume.ts'),
    join(CORE_SRC, 'behavior', 'graph-checkpoint-emit.ts'),
    join(CORE_SRC, 'behavior', 'checkpoint-blackboard-snapshot.ts'),
] as const;

type ProbeRegistryHooks = {
    readonly onGate?: (context: AbgNodeRunContext) => void;
    readonly onAny?: (context: AbgNodeRunContext) => void;
};

type RegressionCheckpointInput = {
    readonly graphId: string;
    readonly runId: string;
    readonly reason: GraphCheckpoint['reason'];
    readonly queuedNodeIds: readonly string[];
    readonly completedNodeIds: readonly string[];
    readonly blackboardEntries?: Readonly<Record<string, unknown>>;
};

export function linearGraph(graphId: string): AbgGraphSpec {
    return {
        id: graphId,
        entryNodeId: 'gate',
        nodes: [
            { id: 'gate', kind: 'action', implementation: 'probe-gate' },
            { id: 'next', kind: 'action', implementation: 'probe-next' },
        ],
        edges: [{ source: 'gate', target: 'next' }],
        rules: [],
        policies: [],
    };
}

export function probeRegistry(executed: string[], hooks: ProbeRegistryHooks = {}) {
    const registry = createAbgNodeRegistry();
    const probe = async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
        executed.push(node.id);
        hooks.onAny?.(context);
        if (node.id === 'gate') {
            hooks.onGate?.(context);
        }
        yield { type: 'started', graphId: context.graphId, nodeId: node.id };
        yield { type: 'success', graphId: context.graphId, nodeId: node.id };
    };
    registry.register('probe-gate', probe);
    registry.register('probe-next', probe);
    return registry;
}

export function turnContext(input: {
    readonly command: RunCoordinatorTurnContext['command'];
    readonly sessionEvents?: readonly AgentEvent[];
    readonly messages?: readonly { readonly role: 'user'; readonly content: string }[];
}): RunCoordinatorTurnContext {
    const sessionEvents = input.sessionEvents;
    return {
        signal: new AbortController().signal,
        command: input.command,
        ...(sessionEvents !== undefined ? { readSessionEvents: async () => sessionEvents } : {}),
        readMessages: async () => input.messages ?? [{ role: 'user', content: 'continue' }],
        nextId: async (prefix) => `${prefix}_regression`,
        appendDurableEvent: async () => {},
        appendDurableEnvelope: async () => {},
    };
}

export function makeRegressionCheckpoint(input: RegressionCheckpointInput): GraphCheckpoint {
    return {
        schemaVersion: 1,
        graphId: input.graphId,
        sessionRunId: input.runId,
        reason: input.reason,
        queuedNodeIds: [...input.queuedNodeIds],
        completedNodeIds: [...input.completedNodeIds],
        nodeStatuses: Object.fromEntries(input.completedNodeIds.map((nodeId) => [nodeId, 'succeeded' as const])),
        attemptsByNodeId: Object.fromEntries(input.completedNodeIds.map((nodeId) => [nodeId, 1])),
        consecutiveFailuresByNodeId: {},
        consecutiveToolFailuresByNodeId: {},
        totalNodeRuns: input.completedNodeIds.length,
        budgetExtensionsUsed: 0,
        maxNodeRuns: 64,
        blackboardEntries: input.blackboardEntries ?? {},
        activeParallelParentIds: [],
        createdAt: SESSION_RESUME_REGRESSION_NOW,
    };
}

export function interruptedSessionEvents(input: {
    readonly runId: string;
    readonly checkpoint: GraphCheckpoint;
}): AgentEvent[] {
    return [
        runStartedEvent(input.runId),
        graphCheckpointEvent(input.runId, input.checkpoint),
        {
            type: 'run.interrupted',
            timestamp: SESSION_RESUME_REGRESSION_NOW,
            sessionId: SESSION_RESUME_REGRESSION_SESSION_ID,
            message: 'run interrupted',
            run: {
                runId: input.runId,
                command: 'run',
                state: 'interrupted',
                reason: 'provider_aborted',
            },
        },
    ];
}

export function runStartedEvent(runId: string): AgentEvent {
    return {
        type: 'run.started',
        timestamp: SESSION_RESUME_REGRESSION_NOW,
        sessionId: SESSION_RESUME_REGRESSION_SESSION_ID,
        message: 'run started',
        run: { runId, command: 'run', state: 'running' },
    };
}

export function graphCheckpointEvent(runId: string, checkpoint: GraphCheckpoint): AgentEvent {
    return {
        type: 'graph.checkpoint',
        timestamp: SESSION_RESUME_REGRESSION_NOW,
        sessionId: SESSION_RESUME_REGRESSION_SESSION_ID,
        run: { runId },
        abg: { graphId: checkpoint.graphId, checkpoint },
    };
}

export function approvalBlockedEvent(input: { readonly runId: string; readonly graphId: string }): AgentEvent {
    return {
        type: 'run.blocked',
        timestamp: SESSION_RESUME_REGRESSION_NOW,
        sessionId: SESSION_RESUME_REGRESSION_SESSION_ID,
        message: 'blocked',
        run: {
            runId: input.runId,
            command: 'run',
            state: 'blocked_on_approval',
            toolCallId: 'tool_regression',
        },
    };
}

export function approvalDecisionEvent(graphId: string): AbgEmbeddedEvent {
    return {
        id: 'approval_decided_regression',
        type: 'approval.updated',
        source: 'human',
        timestamp: SESSION_RESUME_REGRESSION_NOW,
        payload: {
            approvalId: `approval_permission_${graphId}_approve`,
            state: 'approved',
            reason: 'approved in regression pack',
        },
    };
}

export function checkpoints(events: readonly AgentEvent[]): readonly GraphCheckpoint[] {
    return events.flatMap((event) => {
        const checkpoint = event.abg?.checkpoint;
        return event.type === 'graph.checkpoint' && checkpoint !== undefined ? [checkpoint] : [];
    });
}

export function readResumePathSourceTexts(): readonly { readonly sourcePath: string; readonly source: string }[] {
    return RESUME_PATH_SOURCES.map((sourcePath) => ({ sourcePath, source: readFileSync(sourcePath, 'utf8') }));
}
