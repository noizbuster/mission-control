/**
 * CLI-side workflow graph resolution.
 *
 * Single import surface used by BOTH the interactive (`runPromptAction` /
 * `runWorkflowAction`) and non-interactive (`runAgent`) prompt paths so every
 * workflow graph — whether from an explicit `#name` / `--workflow <name>`
 * invocation or the plain-prompt `default` fallback — is materialized through
 * the shared core helper (`materializeWorkflow`). This is the seam the
 * `workflow-default-fallback` regression test pins.
 *
 * Explicit `--graph <path>` is NOT routed through here: an authorable graph is
 * not a workflow, so `runAgent` runs it raw via `runtime.runGraph`.
 */
import {
    materializeWorkflow,
    resolveDefaultWorkflowSpec,
    type WorkflowRegistry,
    workflowModePolicies,
} from '@mission-control/core';
import type { AbgGraphSpec, PolicyEffectRule, WorkflowSpec } from '@mission-control/protocol';

/**
 * Materialize a resolved workflow spec into an executable graph with its
 * declared modes applied. Used by the `#name` and `--workflow <name>` paths.
 */
export function graphForWorkflowSpec(spec: WorkflowSpec): AbgGraphSpec {
    return materializeWorkflow(spec);
}

/**
 * The active modes' policy-gate rules for a resolved workflow spec — the runtime-side
 * companion of {@linkcode graphForWorkflowSpec}. Both CLI paths pair the materialized
 * graph with these rules so mode policies enforce at BOTH layers: universal ('**')
 * rules gate nodes before they run; scoped rules deny write-family tool invocations.
 */
export function modePoliciesForWorkflowSpec(spec: WorkflowSpec): readonly PolicyEffectRule[] | undefined {
    return workflowModePolicies(spec);
}

/**
 * Mode policy rules for the plain-prompt `default` fallback workflow (almost always
 * `undefined`: the shipped `default` workflow declares no modes).
 */
export function modePoliciesForDefaultFallback(
    registry: WorkflowRegistry | undefined,
): readonly PolicyEffectRule[] | undefined {
    if (registry === undefined) {
        return undefined;
    }
    return workflowModePolicies(resolveDefaultWorkflowSpec(registry));
}
/**
 * Resolve and materialize the `default` workflow fallback for a plain prompt.
 * Returns `undefined` when no registry is configured (the caller then falls
 * back to the coding-agent graph). Used by both the interactive plain-prompt
 * path and the non-interactive plain-prompt path.
 */
export function graphForDefaultFallback(registry: WorkflowRegistry | undefined): AbgGraphSpec | undefined {
    if (registry === undefined) {
        return undefined;
    }
    return materializeWorkflow(resolveDefaultWorkflowSpec(registry));
}
