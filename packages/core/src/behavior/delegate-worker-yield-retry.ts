/**
 * Shared retry guidance appended to delegate-worker prompts in the fixer and
 * executer workflow graphs.
 *
 * Keeps parity between the two graphs: when a child task returns
 * task_yield_missing or a degraded-salvage error, the worker retries once with
 * a smaller atomic assignment that explicitly requires tools-then-yield, never
 * prose alone. Soft guidance only — the structural child-only yield guard
 * (`requireYieldBeforeExit`) lives elsewhere; this is the parent-side retry nudge.
 *
 * Prefer relative imports from workflow graph factories; not a public package
 * barrel export.
 */
export const DELEGATE_WORKER_YIELD_RETRY_GUIDANCE =
    'If a task call returns task_yield_missing or a degraded-salvage error, retry once with a ' +
    'smaller atomic assignment (one file or one verification step) and explicitly require the ' +
    'child to call tools as needed, then call yield with the final result; never end on prose ' +
    'alone.';
