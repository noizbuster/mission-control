import type { AbgNodeSpec } from '@mission-control/protocol';
import type { AuthorableAbgGraph } from './authorable-graph.js';
import type { CoordinatorState } from './graph-coordinator-helpers.js';
import { findNode } from './graph-coordinator-helpers.js';
import type { AbgGraphRunnerInput } from './graph-runner.js';
import { nodeWaitingEvent } from './graph-runner-events.js';

type ResourceLimit = {
    readonly key: 'graph' | 'provider-tool' | 'shell';
    readonly limit: number;
    readonly reason: string;
};

export function scheduleQueuedNodes(
    graph: AuthorableAbgGraph,
    state: CoordinatorState,
    input: AbgGraphRunnerInput,
): readonly AbgNodeSpec[] {
    const selected: AbgNodeSpec[] = [];
    const remainingNodeIds: string[] = [];
    const resourceCounts: Partial<Record<ResourceLimit['key'], number>> = {};
    const graphCapacity = Math.min(state.graphNodeConcurrency, state.maxNodeRuns - state.totalNodeRuns);

    while (state.queuedNodeIds.length > 0) {
        const nodeId = state.queuedNodeIds.shift();
        if (nodeId === undefined) {
            continue;
        }
        const node = findNode(graph, nodeId);
        const graphLimit = {
            key: 'graph',
            limit: graphCapacity,
            reason: `graph concurrency limit ${state.graphNodeConcurrency}`,
        } satisfies ResourceLimit;
        const resourceLimit = resourceLimitForNode(node, state);
        const blockedLimit = firstBlockedLimit([graphLimit, resourceLimit], selected.length, resourceCounts);
        if (blockedLimit !== undefined) {
            state.events.push(nodeWaitingEvent(graph.id, node, input, blockedLimit.reason));
            remainingNodeIds.push(node.id);
            continue;
        }
        selected.push(node);
        resourceCounts[resourceLimit.key] = (resourceCounts[resourceLimit.key] ?? 0) + 1;
    }

    state.queuedNodeIds.push(...remainingNodeIds);
    return selected;
}

function firstBlockedLimit(
    limits: readonly ResourceLimit[],
    graphSelectedCount: number,
    resourceCounts: Partial<Record<ResourceLimit['key'], number>>,
): ResourceLimit | undefined {
    for (const limit of limits) {
        const activeCount = limit.key === 'graph' ? graphSelectedCount : (resourceCounts[limit.key] ?? 0);
        if (activeCount >= limit.limit) {
            return limit;
        }
    }
    return undefined;
}

function resourceLimitForNode(node: AbgNodeSpec, state: CoordinatorState): ResourceLimit {
    if (isShellNode(node)) {
        return {
            key: 'shell',
            limit: state.shellConcurrency,
            reason: `shell concurrency limit ${state.shellConcurrency}`,
        };
    }
    if (node.kind === 'tool') {
        return {
            key: 'provider-tool',
            limit: state.providerToolCallConcurrency,
            reason: `provider tool call concurrency limit ${state.providerToolCallConcurrency}`,
        };
    }
    return {
        key: 'graph',
        limit: state.graphNodeConcurrency,
        reason: `graph concurrency limit ${state.graphNodeConcurrency}`,
    };
}

function isShellNode(node: AbgNodeSpec): boolean {
    return (node.capabilities ?? []).includes('command.run');
}
