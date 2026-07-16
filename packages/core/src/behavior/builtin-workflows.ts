import type { Mode, WorkflowSpec } from '@mission-control/protocol';
import { createDefaultWorkflowGraph, DEFAULT_PLAN_READONLY_MODE } from './default-workflow-graph';
import { createExecuterWorkflowGraph } from './executer-workflow-graph';
import { createFixerWorkflowGraph } from './fixer-workflow-graph';
import { autopilotMode } from './modes/autopilot-mode';
import { createPlannerWorkflowGraph, PLANNER_READONLY_MODE } from './planner-workflow-graph';

/**
 * Built-in workflow catalog (ABG-aligned):
 *
 * | Name | Role |
 * | --- | --- |
 * | `default` | Plan-first plain-prompt fallback |
 * | `planner` | Deep autonomous planning craft |
 * | `executer` | Plan execution conductor |
 * | `fixer` | Intent-gated implement/fix path |
 *
 * Autopilot remains a mode overlay, not a standalone graph.
 */
export const BUILTIN_WORKFLOWS: readonly WorkflowSpec[] = [
    {
        name: 'default',
        description:
            'Plan-first plain-prompt fallback: ambiguity assessment, explore/research, draft, review, approval, write plan scaffold. Never implements product code.',
        graph: createDefaultWorkflowGraph(),
        modes: [DEFAULT_PLAN_READONLY_MODE],
    },
    {
        name: 'planner',
        description:
            'Deep autonomous planning craft: explore hierarchy before questions, sticky plan mode, draft/review/approval, scaffold to .omo/plans/.',
        graph: createPlannerWorkflowGraph(),
        modes: [PLANNER_READONLY_MODE],
    },
    {
        name: 'executer',
        description:
            'Plan execution conductor: admit plan, parallel delegate waves, verify-before-checkbox, F1–F4 final wave, 3-strike fix loop.',
        graph: createExecuterWorkflowGraph(),
    },
    {
        name: 'fixer',
        description:
            'Intent-gated implement/fix path: five-class intent gate, maturity check, anti-dup guard, delegate + verify + evidence, 3-strike supervisor.',
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
