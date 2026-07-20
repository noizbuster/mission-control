/**
 * Workflow materialization: the shared seam that turns a resolved
 * {@link WorkflowSpec} into an executable {@link AbgGraphSpec} with declared
 * modes applied.
 *
 * Both CLI invocation paths (interactive `#name` / plain prompt and
 * non-interactive `--workflow` / plain prompt) route through `materializeWorkflow`
 * so that mode overlays (`planner-readonly`, `autopilot`, ...) land on the
 * EXECUTED graph, not only on the persisted Mission record.
 *
 * Pure: the input spec and its nested graph are never mutated. `applyMode`
 * shallow-copies every branch it touches, and this helper folds over
 * `spec.modes` in declaration order so last-match-wins policy semantics
 * (broad deny first, specific allow after) are preserved.
 */
import type { AbgGraphSpec, Mode, WorkflowSpec } from '@mission-control/protocol';
import { createDefaultWorkflowGraph } from '../behavior/default-workflow-graph';
import { applyMode } from '../behavior/modes/mode-application';
import { assertRoutingKeyBiCoverage } from '../behavior/routing-key-bi-coverage';

/** The workflow name used as the no-`#` / plain-prompt fallback. */
export const DEFAULT_WORKFLOW_NAME = 'default';

/**
 * Options for {@link materializeWorkflow}.
 *
 * `activeModeIds` selects which of `spec.modes` are applied. When omitted, every
 * declared mode is active — mirroring `materializeMission`, which marks all
 * declared modes `active: true` unless a `modeDeclaration` toggles them off.
 */
export type MaterializeWorkflowOptions = {
    readonly activeModeIds?: readonly string[];
};

/**
 * Materialize a resolved workflow spec into an executable graph.
 *
 * Folds each declared (and, when `activeModeIds` is provided, selected) mode
 * through `applyMode`, producing a new graph whose `policies` carry the
 * mode-converted policy-gate rules and whose `llm`-kind nodes carry the
 * overlay prompts. The input spec is never mutated.
 *
 * When the spec declares no modes the graph is returned by value-safe identity
 * (no modes applied) so callers can treat the result uniformly.
 */
export function materializeWorkflow(spec: WorkflowSpec, options: MaterializeWorkflowOptions = {}): AbgGraphSpec {
    const declaredModes = spec.modes;
    if (declaredModes === undefined || declaredModes.length === 0) {
        assertRoutingKeyBiCoverage(spec.graph);
        return spec.graph;
    }
    const activeFilter = options.activeModeIds !== undefined ? new Set(options.activeModeIds) : undefined;
    let graph = spec.graph;
    for (const mode of declaredModes) {
        if (activeFilter === undefined || activeFilter.has(mode.id)) {
            graph = applyMode(graph, mode);
        }
    }
    assertRoutingKeyBiCoverage(graph);
    return graph;
}

/**
 * Lookup shape accepted by {@link resolveDefaultWorkflowSpec}. Decoupled from
 * the concrete `WorkflowRegistry` so tests and lightweight callers can pass a
 * minimal stub.
 */
export type WorkflowLookup = {
    readonly lookup: (name: string) => WorkflowSpec | undefined;
};

/**
 * Resolve the `default` workflow spec from a registry, falling back to a fresh
 * {@link createDefaultWorkflowGraph} wrapper when `default` is not discovered.
 *
 * The fallback keeps the plain-prompt path runnable even when discovery yields
 * no `default` entry (e.g. a stripped-down registry in tests or a workspace
 * with no `.mctrl/workflows/` and no builtin registration).
 */
export function resolveDefaultWorkflowSpec(registry: WorkflowLookup): WorkflowSpec {
    const discovered = registry.lookup(DEFAULT_WORKFLOW_NAME);
    if (discovered !== undefined) {
        return discovered;
    }
    return {
        name: DEFAULT_WORKFLOW_NAME,
        graph: createDefaultWorkflowGraph(),
    };
}

/** Re-exported for callers that need the mode type alongside materialization. */
export type { Mode };
