/**
 * The default workflow graph: the no-`#` plain-prompt fallback.
 *
 * Intent-gated implementer (not a plan-scaffold workflow):
 *
 *   intent-gate (5 classes) -> {
 *     trivial                  -> direct-respond
 *     exploratory-research     -> research-explore (read-only) -> final-respond
 *     open-ended-planning      -> route-planner (#planner or ONE question; NEVER implement)
 *     explicit-implementation  -> memory -> maturity-sample -> maturity-classify ->
 *                                 anti-dup-guard -> todo-plan -> delegate-wave ->
 *                                 verify-wave -> {
 *                                     critic-passed -> evidence-check -> final-respond
 *                                   | critic-failed -> supervisor (3-strike) -> retry|final-respond
 *                                 }
 *     ambiguous                -> clarify -> intent-gate
 *   }
 *
 * Role:
 * - Default: implement, don't force a full plan scaffold.
 * - Multi-step work uses lightweight todos (`plan.todos`), not `.mc/plans` scaffolds.
 * - Full strategic planning is `#planner`. Plan execution is `#executer`.
 * - `#fixer` is the explicit alias of the same implement/fix graph family.
 *
 * Built on {@link createFixerWorkflowGraph}: same nodes/edges/rules; graph id is `default`
 * and the intent-gate prompt is action-default (goal first, implement unless pure question).
 */
import type { AbgGraphSpec, AbgNodeModelOptions, AbgNodeSpec } from '@mission-control/protocol';
import {
    createFixerWorkflowGraph,
    FIXER_WORKFLOW_MAX_NODE_RUNS,
    type FixerWorkflowGraphOptions,
} from './fixer-workflow-graph';

export const DEFAULT_WORKFLOW_GRAPH_ID = 'default';
/** Graph loop bound for the default implement path (shared with fixer research + synthesis budget). */
export const DEFAULT_WORKFLOW_MAX_NODE_RUNS = FIXER_WORKFLOW_MAX_NODE_RUNS;

/**
 * Default intent gate: surface form → true intent → route.
 * Action-default; pure question only when the user clearly wants explanation-only.
 */
export const DEFAULT_INTENT_GATE_PROMPT =
    'You are the intent gate for the default workflow. Map the user surface request ' +
    'to its true intent, then classify. Default bias: the message implies ACTION unless the user ' +
    'explicitly wants explanation-only.\n\n' +
    'Intent routing map (surface form -> true intent -> routing):\n' +
    '- "explain X", "how does Y work", "what is Z", "find Y" with no fix/implement ask -> ' +
    'exploratory-research (read + synthesize, NEVER edit files).\n' +
    '- "implement X", "add Y", "fix Z", "create W", "bug", "broken", "doesn\'t work", or any ' +
    'clear scoped change -> explicit-implementation (todos + delegate/self-execute + verify).\n' +
    '- "refactor", "improve", "make X better", "clean up", "optimize" with no clear target -> ' +
    'open-ended-planning (route to #planner or ask exactly ONE question; NEVER implement silently).\n' +
    '- greeting, thanks, simple factual one-liner needing no tools -> trivial.\n' +
    '- vague, multiple plausible interpretations, or missing critical info -> ambiguous.\n\n' +
    'Mis-routing open-ended to explicit-implementation silently implements when the user wanted ' +
    'consultation first — when genuinely unsure between open-ended-planning and ' +
    'explicit-implementation, prefer open-ended-planning.\n\n' +
    'Output ONLY one class name — no quotes, no formatting, no extra text:\n' +
    '- trivial\n' +
    '- exploratory-research\n' +
    '- open-ended-planning\n' +
    '- explicit-implementation\n' +
    '- ambiguous';

export type DefaultWorkflowGraphOptions = FixerWorkflowGraphOptions & {
    readonly model?: AbgNodeModelOptions;
    readonly maxNodeRuns?: number;
};

/**
 * Build the default plain-prompt graph (intent-gated implementer).
 * Structurally shares the fixer implement path; id is `default`.
 */
export function createDefaultWorkflowGraph(options: DefaultWorkflowGraphOptions = {}): AbgGraphSpec {
    const fixer = createFixerWorkflowGraph({
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.maxNodeRuns !== undefined ? { maxNodeRuns: options.maxNodeRuns } : {}),
    });
    return {
        ...fixer,
        id: DEFAULT_WORKFLOW_GRAPH_ID,
        defaults: {
            ...fixer.defaults,
            // Soft-land / dead-end recovery lands on final-respond (user-visible).
            escalationTarget: 'final-respond',
        },
        nodes: fixer.nodes.map((node) => mapDefaultNode(node)),
    };
}

function mapDefaultNode(node: AbgNodeSpec): AbgNodeSpec {
    if (node.id !== 'intent-gate') {
        return node;
    }
    return {
        ...node,
        label: 'Intent gate: classify into 5 classes',
        config: {
            ...node.config,
            systemPrompt: DEFAULT_INTENT_GATE_PROMPT,
            outputKey: 'intent.classification',
            outputEnum: [
                'trivial',
                'exploratory-research',
                'open-ended-planning',
                'explicit-implementation',
                'ambiguous',
            ],
        },
    };
}
