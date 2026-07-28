/**
 * Shared retry guidance appended to delegate-worker prompts in the fixer and
 * executer workflow graphs.
 *
 * A child task that completes without calling `yield` now returns its final assistant text
 * as a successful (degraded) result rather than a failure (the old must-yield-or-fail
 * contract trapped models that answer in prose and discarded their work). The worker judges
 * a task result by its CONTENT, not by an error code: if the output reads as partial or
 * mid-work, re-delegate once with a smaller atomic assignment. Soft guidance only.
 *
 * Prefer relative imports from workflow graph factories; not a public package
 * barrel export.
 */
export const DELEGATE_WORKER_YIELD_RETRY_GUIDANCE =
    'Judge each task result by its content. A child may complete without calling `yield`; its final ' +
    'text is then its result. If that output looks partial or unfinished (e.g. it trails off ' +
    'mid-sentence or describes a next step it never took), re-delegate once with a smaller atomic ' +
    'assignment (one file or one verification step) and ask the child to call `yield` with the ' +
    'finished result. Do not retry a result that is clearly complete.';
