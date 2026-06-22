/**
 * Workflows subsystem public surface: `*.workflow.json(c)` discovery
 * (3-scope, first-wins by name, never-throws) and the in-memory registry.
 * Re-exported from the package root (packages/core/src/index.ts).
 */

export {
    DEFAULT_MAX_WORKFLOW_FILE_BYTES,
    DEFAULT_MAX_WORKFLOWS,
    type DiscoverWorkflowsOptions,
    type DiscoverWorkflowsResult,
    discoverWorkflows,
} from './workflow-loader.js';
export { WorkflowRegistry } from './workflow-registry.js';
