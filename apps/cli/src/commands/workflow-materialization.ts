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
import { materializeWorkflow, resolveDefaultWorkflowSpec, type WorkflowRegistry } from '@mission-control/core';
import type { AbgGraphSpec, WorkflowSpec } from '@mission-control/protocol';

/**
 * Materialize a resolved workflow spec into an executable graph with its
 * declared modes applied. Used by the `#name` and `--workflow <name>` paths.
 */
export function graphForWorkflowSpec(spec: WorkflowSpec): AbgGraphSpec {
    return materializeWorkflow(spec);
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
