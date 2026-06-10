import type { AbgGraphInput, AbgGraphStatus, AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import { runBoundedAbgGraph } from './graph-coordinator.js';
import type { AbgNodeRegistry } from './node-registry.js';

export type AbgGraphRunnerInput = {
    readonly graph: unknown;
    readonly graphInput?: AbgGraphInput;
    readonly sessionId: string;
    readonly now: () => string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly registry?: AbgNodeRegistry;
    readonly maxNodeRuns?: number;
    readonly graphNodeConcurrency?: number;
    readonly providerToolCallConcurrency?: number;
    readonly shellConcurrency?: number;
};

export type AbgGraphRunResult = {
    readonly graphId: string;
    readonly status: AbgGraphStatus;
    readonly events: readonly AgentEvent[];
};

export async function runAbgGraph(input: AbgGraphRunnerInput): Promise<AbgGraphRunResult> {
    return runBoundedAbgGraph(input);
}
