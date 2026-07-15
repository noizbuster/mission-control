/**
 * Workflows subsystem public surface: `*.workflow.json(c)` discovery
 * (3-scope, first-wins by name, never-throws) and the in-memory registry.
 * Re-exported from the package root (packages/core/src/index.ts).
 */

export {
    DEFAULT_WORKFLOW_NAME,
    type MaterializeWorkflowOptions,
    materializeWorkflow,
    resolveDefaultWorkflowSpec,
    type WorkflowLookup,
} from './materialize-workflow';
export {
    DEFAULT_MAX_WORKFLOW_FILE_BYTES,
    DEFAULT_MAX_WORKFLOWS,
    type DiscoverWorkflowsOptions,
    type DiscoverWorkflowsResult,
    discoverWorkflows,
} from './workflow-loader';
export { WorkflowRegistry } from './workflow-registry';
