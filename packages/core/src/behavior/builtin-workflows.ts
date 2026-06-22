import type { Mode, WorkflowSpec } from '@mission-control/protocol';
import { createDefaultWorkflowGraph } from './default-workflow-graph.js';
import { createPlannerWorkflowGraph, PLANNER_READONLY_MODE } from './planner-workflow-graph.js';
import { createRunnerWorkflowGraph } from './runner-workflow-graph.js';
import { autopilotMode } from './modes/autopilot-mode.js';

export const BUILTIN_WORKFLOWS: readonly WorkflowSpec[] = [
    {
        name: 'default',
        description: 'Intent-gated coding agent: trivial, explicit, or ambiguous routing',
        graph: createDefaultWorkflowGraph(),
    },
    {
        name: 'planner',
        description: 'Read-only planning with ambiguity assessment and plan drafting',
        graph: createPlannerWorkflowGraph(),
        modes: [PLANNER_READONLY_MODE],
    },
    {
        name: 'runner',
        description: 'Plan execution with delegation waves and four-critic verification',
        graph: createRunnerWorkflowGraph(),
    },
];

export const BUILTIN_MODES: readonly Mode[] = [autopilotMode];

export function registerBuiltinWorkflows(registry: {
    registerWorkflow(spec: WorkflowSpec): void;
    registerMode(mode: Mode): void;
}): void {
    for (const spec of BUILTIN_WORKFLOWS) {
        registry.registerWorkflow(spec);
    }
    for (const mode of BUILTIN_MODES) {
        registry.registerMode(mode);
    }
}
