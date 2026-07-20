import type { Mode, WorkflowSpec } from '@mission-control/protocol';
import { createDefaultWorkflowGraph } from './default-workflow-graph';
import { createExecuterWorkflowGraph } from './executer-workflow-graph';
import { createFixerWorkflowGraph } from './fixer-workflow-graph';
import { autopilotMode } from './modes/autopilot-mode';
import { createPlannerWorkflowGraph, PLANNER_READONLY_MODE } from './planner-workflow-graph';

/**
 * Built-in workflow catalog (ABG-aligned):
 *
 * | Name | Role |
 * | --- | --- |
 * | `default` | Plain-prompt fallback: intent-gated implement/fix path |
 * | `planner` | Sticky read-only planning; writes plan scaffolds only |
 * | `executer` | Executes an approved plan with verify-before-checkbox discipline |
 * | `fixer` | Explicit intent-gated implement/fix path (same family as default) |
 *
 * Autopilot remains a mode overlay, not a standalone graph.
 */
export const BUILTIN_WORKFLOWS: readonly WorkflowSpec[] = [
    {
        name: 'default',
        description:
            'Plain-prompt fallback: classify intent, then either answer, research read-only, route to #planner, ' +
            'or run todo-backed implementation with verify/evidence and a 3-strike supervisor. Does not force ' +
            'full .mc/plans scaffolds — use #planner for strategic planning.',
        graph: createDefaultWorkflowGraph(),
    },
    {
        name: 'planner',
        description:
            'Sticky read-only planning: explore before questions, draft/review/approval, write scaffold plans to ' +
            '.mc/plans/. Never implements product code.',
        graph: createPlannerWorkflowGraph(),
        modes: [PLANNER_READONLY_MODE],
    },
    {
        name: 'executer',
        description:
            'Plan execution: admit approved plan, parallel delegate waves, verify-before-checkbox, F1–F4 final ' +
            'wave, 3-strike fix loop.',
        graph: createExecuterWorkflowGraph(),
    },
    {
        name: 'fixer',
        description:
            'Intent-gated implement/fix path: five-class intent gate, maturity check, anti-dup guard, ' +
            'todo plan, delegate + verify + evidence, 3-strike supervisor.',
        graph: createFixerWorkflowGraph(),
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
