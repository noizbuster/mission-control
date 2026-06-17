import type { AbgNodeModelOptions, AbgNodeSpec, AbgPolicySpec, AbgSignal, AgentEvent } from '@mission-control/protocol';
import type { Blackboard } from '../memory/blackboard.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { CostLedger } from './budget/cost-ledger.js';
import { createCompositeNodeRunners } from './nodes/composite-nodes.js';
import { createLeafNodeRunners } from './nodes/leaf-nodes.js';
import type { LlmActorModel } from './nodes/llm-actor/llm-actor-node.js';

export type AbgObservedGraphEvent = {
    readonly type: string;
};

export type AbgNodeRunContext = {
    readonly graphId: string;
    readonly now: () => string;
    readonly registry?: AbgNodeRegistry;
    readonly nodes?: Readonly<Record<string, AbgNodeSpec | undefined>>;
    readonly observedEvents?: readonly AbgObservedGraphEvent[];
    readonly model?: AbgNodeModelOptions;
    /**
     * The resolved Vercel AI SDK model for this run (`AbgNodeModelOptions` → SDK model).
     * `LLMActor` calls `streamText` with this. Resolved by `resolveSdkModel` on the graph
     * input (Phase 5 wires the real provider registry; Phase 1 injects a scripted/mock
     * resolver in tests).
     */
    readonly sdkModel?: LlmActorModel;
    readonly policies?: readonly AbgPolicySpec[];
    readonly input?: Readonly<Record<string, unknown>>;
    /**
     * The live Blackboard (ABG §10.4 runtime memory). The SAME instance is handed to
     * every node run, so writes persist across the Observe→Decide→Act loop. `LLMActor`
     * reads/writes the running message list here; `MemoryNode` reads/writes key/value
     * entries; rule-gated re-entry edges read entries via `blackboard.*` predicates.
     */
    readonly blackboard?: Blackboard;
    /**
     * The `ToolRegistry` exposing the real tools. `ToolActor` resolves + invokes tools
     * through this (version check, JSON parse, schema validation, output bounding, events).
     */
    readonly toolRegistry?: ToolRegistry;
    /**
     * Abort/interrupt signal threaded from the run owner. Nodes that perform long or
     * cancellable work (LLM stream, tool execution) should honor it so the graph agent
     * is at least as interruptible as the flat loop it replaces (ABG: cancellation is
     * normal control flow).
     */
    readonly abortSignal?: AbortSignal;
    /**
     * Per-run cost ledger (ABG §11.4). When present, `LLMActor` prices each turn's usage
     * against the configured `PricingTable` and emits `policy.budget.accumulated` /
     * `.warning` / `.exceeded` events. Created once by the coordinator from the graph's
     * `budgetCents` + a supplied pricing table; shared across loop re-entries.
     */
    readonly budgetLedger?: CostLedger;
    /**
     * Forwards a tool's own events (file.diff.applied, command lifecycle, ...) directly into the
     * graph event stream — session-scoped by the coordinator. `LLMActor` wires the tool bridge's
     * `onToolEvent` to this so the graph surfaces the same rich tool events the flat run loop's
     * `settleToolCalls` appends (the adapter still owns the graph-canonical tool lifecycle).
     */
    readonly emitEvent?: (event: AgentEvent) => void;
};

export type AbgNodeRunner = (node: AbgNodeSpec, context: AbgNodeRunContext) => AsyncIterable<AbgSignal>;

export class AbgNodeRegistryError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AbgNodeRegistryError';
    }
}

export interface AbgNodeRegistry {
    register(id: string, runner: AbgNodeRunner): void;
    resolve(id: string): AbgNodeRunner;
}

export function createAbgNodeRegistry(): AbgNodeRegistry {
    return new DefaultAbgNodeRegistry();
}

export function createDefaultAbgNodeRegistry(): AbgNodeRegistry {
    const registry = createAbgNodeRegistry();
    for (const [id, runner] of createLeafNodeRunners()) {
        registry.register(id, runner);
    }
    for (const [id, runner] of createCompositeNodeRunners()) {
        registry.register(id, runner);
    }
    return registry;
}

export function runAbgNode(
    registry: AbgNodeRegistry,
    node: AbgNodeSpec,
    context: AbgNodeRunContext,
): AsyncIterable<AbgSignal> {
    const implementationId = node.implementation ?? node.kind;
    return registry.resolve(implementationId)(node, context);
}

class DefaultAbgNodeRegistry implements AbgNodeRegistry {
    private readonly runners = new Map<string, AbgNodeRunner>();

    register(id: string, runner: AbgNodeRunner): void {
        if (this.runners.has(id)) {
            throw new AbgNodeRegistryError(`ABG node implementation already registered: ${id}`);
        }
        this.runners.set(id, runner);
    }

    resolve(id: string): AbgNodeRunner {
        const runner = this.runners.get(id);
        if (runner === undefined) {
            throw new AbgNodeRegistryError(`Unknown ABG node implementation: ${id}`);
        }
        return runner;
    }
}
