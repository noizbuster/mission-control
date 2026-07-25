import type {
    AbgNodeModelOptions,
    AbgNodeSpec,
    AbgPolicySpec,
    AbgSignal,
    AgentEvent,
    PolicyEffectRule,
} from '@mission-control/protocol';
import type { ProjectInstructionResource } from '../context/project-context-messages';
import type { SystemPromptEnvironment } from '../context/system-prompt';
import type { Blackboard } from '../memory/blackboard';
import type { ObservabilityRedactor } from '../providers/observability-redactor';
import type { ToolRegistry } from '../tools/tool-registry';
import type { CostLedger } from './budget/cost-ledger';
import { createCompositeNodeRunners } from './nodes/composite-nodes';
import { createLeafNodeRunners } from './nodes/leaf-nodes';
import type { LlmActorModel } from './nodes/llm-actor/llm-actor-node';

export type AbgObservedGraphEvent = {
    readonly type: string;
};

export type AbgNodeRunContext = {
    readonly graphId: string;
    readonly sessionId?: string;
    readonly now: () => string;
    readonly toolCallId?: string;
    readonly registry?: AbgNodeRegistry;
    readonly nodes?: Readonly<Record<string, AbgNodeSpec | undefined>>;
    readonly observedEvents?: readonly AbgObservedGraphEvent[];
    readonly model?: AbgNodeModelOptions;
    readonly graphTimeoutMs?: number;
    /**
     * The resolved Vercel AI SDK model for this run (`AbgNodeModelOptions` → SDK model).
     * `LLMActor` calls `streamText` with this. Resolved by `resolveSdkModel` on the graph
     * input (Phase 5 wires the real provider registry; Phase 1 injects a scripted/mock
     * resolver in tests).
     */
    readonly sdkModel?: LlmActorModel;
    readonly policies?: readonly AbgPolicySpec[];
    /**
     * Workflow mode policy-gate rules (Task 1.2 / 3.2) in the action/resource/effect vocabulary.
     * Threaded from the active {@linkcode Mode}'s `policies` at materialization. The
     * `mode-policy-gate` node evaluates these via `evaluateRules` to enforce e.g. the planner's
     * read-only scope (deny writes except `.mc/plans/**` and `.mc/specs/**`). Distinct from
     * {@linkcode policies} (the graph-level `AbgPolicySpec` capability/decision model); both
     * coexist by design.
     */
    readonly modePolicies?: readonly PolicyEffectRule[];
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
    readonly controlEpoch?: import('../runtime/session-control-cancellation').SessionControlEpoch;
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
    /**
     * Fail the run on the first non-approval tool settlement failure instead of surfacing it to the
     * model (parity with the flat run coordinator's `haltOnFailedToolSettlement`). Threaded from
     * `AbgGraphRunnerInput`; `LLMActor` consults the settlement ledger for a terminal failure.
     */
    readonly haltOnFailedToolSettlement?: boolean;
    /**
     * Serialize a tool BATCH so at most one tool executes at a time within a turn (interactive graph
     * path): `LLMActor` forwards this to the tool bridge, which wraps each tool's `execute` in a
     * shared mutex. Keeps the interactive approval broker's single-pending invariant when the model
     * proposes multiple tools in one step. Omitted on the non-interactive path (parallel batches).
     */
    readonly serializeToolExecution?: boolean;
    /**
     * Environment block for the coding-agent system prompt (cwd, workspaceRoot, git, platform, date,
     * modelId). When present, `LLMActor` includes a `# Environment` section so the model knows where
     * it is operating. Without this the model has no workspace awareness and tends to answer
     * generically instead of acting on the codebase.
     */
    readonly systemPromptEnv?: SystemPromptEnvironment;
    /**
     * Trusted project instruction resources (AGENTS.md / CLAUDE.md) discovered + read by the caller
     * (CLI/desktop). When present, `LLMActor` appends them to the system prompt as reference data
     * (framed as untrusted context, never commands that override policy — see system-prompt.ts).
     * The graph never loads these itself; the caller owns trust-aware discovery.
     */
    readonly projectInstructionResources?: readonly ProjectInstructionResource[];
    readonly observabilityRedactor?: ObservabilityRedactor;
    readonly retryCorrection?: string;
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
