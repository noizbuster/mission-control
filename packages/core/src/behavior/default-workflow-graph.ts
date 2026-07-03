/**
 * The default workflow graph: the no-`#` fallback that replaces the coding-agent graph as
 * the default prompt path (plan Task 2.5, ABG Round 8 decomposition; richness port Task 11).
 *
 *   intent-gate (verbalize + classify into 5 classes) -> {
 *     trivial                  -> direct-respond (llm self-loop)
 *     exploratory-research     -> research-explore (read-only, NO edits) -> final-respond
 *     open-ended-planning      -> route-planner (route to #planner or ask ONE question;
 *                                 NEVER implement) -> final-respond
 *     explicit-implementation  -> memory -> maturity-check -> anti-dup-guard ->
 *                                 todo-plan -> delegate-wave -> verify-wave -> {
 *                                     critic-passed -> evidence-check -> final-respond
 *                                   | critic-failed -> supervisor (3-strike) -> {
 *                                         retry     -> delegate-wave (bounded)
 *                                       | escalated -> final-respond
 *                                     }
 *                                 }
 *     ambiguous                -> clarify -> intent-gate (re-classify)
 *   }
 *
 * Ported Sisyphus behavioral semantics (reference only; no reference code imported):
 *   - Intent verbalization: the gate states its chosen intent + reasoning before emitting
 *     the classification (Sisyphus Phase 0 intent_verbalization).
 *   - Richer intent classes: trivial / exploratory-research / open-ended-planning /
 *     explicit-implementation / ambiguous (Sisyphus Step 1 classify request type).
 *   - Codebase maturity assessment: before following patterns, classify the codebase as
 *     disciplined / transitional / legacy / greenfield (Sisyphus Phase 1).
 *   - Anti-dup exploration guard + delegation-bias check: before delegating, confirm prior
 *     exploration is not duplicated and delegation is the right move vs doing it directly
 *     (Sisyphus Anti_Duplication + Delegation Check).
 *   - Evidence requirements: after delegation, verify concrete evidence (test results, file
 *     changes, command output), not just the child's "done" claim (Sisyphus Evidence
 *     Requirements + personal verification).
 *   - 3-strike failure recovery: after 3 consecutive delegation failures, stop and escalate
 *     rather than looping forever (Sisyphus Phase 2C After 3 Consecutive Failures).
 *   - Open-ended/planning NEVER implements silently: route-planner hands off to #planner or
 *     asks exactly ONE clarifying question (Sisyphus "refactor/improve" routing).
 *
 * allow: SIZE_OK - indivisible declarative graph spec byte-identity-tested against the
 * fixture as one unit via `toEqual` (`default-workflow-graph.test.ts`). Sibling factories
 * (planner: 391 LOC, runner) follow the same data-table pattern; this one grew because the
 * Sisyphus richness adds nodes (research-explore, route-planner, maturity-check,
 * anti-dup-guard, evidence-check) and richer prompts.
 */
import type { AbgGraphSpec, AbgNodeModelOptions } from '@mission-control/protocol';

export const DEFAULT_WORKFLOW_GRAPH_ID = 'default';
export const DEFAULT_WORKFLOW_MAX_NODE_RUNS = 48;

/**
 * The supervisor's bounded retry budget. After this many consecutive delegation failures
 * the supervisor escalates instead of retrying. Mirrors the Sisyphus "After 3 Consecutive
 * Failures: STOP, REVERT, DOCUMENT, CONSULT, ASK USER" discipline.
 */
export const DEFAULT_WORKFLOW_STRIKE_BUDGET = 3;

export type DefaultWorkflowGraphOptions = {
    /**
     * Provider/model pin for the graph's `defaults.model`. When omitted, the graph does NOT
     * declare a default model; the runtime resolves each LLM node's model from the session's
     * `modelProviderSelection` (the logged-in provider) at `runContext` time. Pass an explicit
     * model only when a graph should override the session provider.
     */
    readonly model?: AbgNodeModelOptions;
    /** Graph loop bound. Default 48. */
    readonly maxNodeRuns?: number;
};

export function createDefaultWorkflowGraph(options: DefaultWorkflowGraphOptions = {}): AbgGraphSpec {
    return {
        id: DEFAULT_WORKFLOW_GRAPH_ID,
        version: '0.1.0',
        entryNodeId: 'intent-gate',
        defaults: {
            ...(options.model !== undefined ? { model: options.model } : {}),
            maxNodeRuns: options.maxNodeRuns ?? DEFAULT_WORKFLOW_MAX_NODE_RUNS,
        },
        nodes: [
            {
                id: 'intent-gate',
                kind: 'llm',
                label: 'Intent gate — verbalize intent, then classify into 5 classes',
                config: {
                    systemPrompt:
                        'You are the intent gate for the default workflow. Before classifying, STATE your ' +
                        "chosen intent and your reasoning: map the user's surface request to its true intent " +
                        '(the real goal behind the words), then announce your routing decision.\n\n' +
                        'Intent routing map (surface form -> true intent -> your routing):\n' +
                        '- "explain X", "how does Y work", "what is Z", "find Y" -> exploratory-research ' +
                        '(read + synthesize, NEVER edit files).\n' +
                        '- "implement X", "add Y", "fix Z", "create W" with clear scope -> explicit-implementation ' +
                        '(structured todos + delegate + verify).\n' +
                        '- "refactor", "improve", "make X better", "clean up", "optimize" with no clear target -> ' +
                        'open-ended-planning (route to #planner or ask exactly ONE question; NEVER implement).\n' +
                        '- greeting, simple factual question, single-turn answer needing no tools -> trivial.\n' +
                        '- vague, multiple plausible interpretations, or missing critical info -> ambiguous.\n\n' +
                        'Mis-routing an open-ended request to explicit-implementation silently implements when the ' +
                        'user wanted to be consulted first — when genuinely unsure between open-ended-planning and ' +
                        'explicit-implementation, prefer open-ended-planning.\n\n' +
                        'Output EXACTLY one class name on a single line, nothing else:\n' +
                        '- trivial\n' +
                        '- exploratory-research\n' +
                        '- open-ended-planning\n' +
                        '- explicit-implementation\n' +
                        '- ambiguous',
                    outputKey: 'intent.classification',
                },
            },
            {
                id: 'direct-respond',
                kind: 'llm',
                label: 'Direct response — trivial prompts',
            },
            {
                id: 'research-explore',
                kind: 'llm',
                label: 'Exploratory research — read-only, NO edits',
                capabilities: ['read'],
                config: {
                    systemPrompt:
                        'Exploratory/research intent. Explore the codebase and/or external docs to answer the ' +
                        "user's question, then synthesize a grounded answer. You are READ-ONLY: you must NOT " +
                        'edit, write, patch, or run effectful tools. Cite file:line evidence for every claim ' +
                        'about the codebase. Do NOT begin implementation — if the exploration reveals the user ' +
                        'actually wants implementation, say so and stop. Set explore.complete when synthesis is ' +
                        'ready.',
                    outputKey: 'explore.complete',
                },
            },
            {
                id: 'route-planner',
                kind: 'llm',
                label: 'Open-ended planning — route to #planner or ask ONE question, NEVER implement',
                capabilities: ['workflow'],
                config: {
                    systemPrompt:
                        'Open-ended/planning intent ("improve", "refactor", "make X better"). You MUST NOT ' +
                        'implement directly. Do exactly one of:\n' +
                        '1. Route to the planner workflow via the workflow tool: workflow("planner", "<the ' +
                        'user\'s request>"). Use this when the request needs a real plan before any code.\n' +
                        '2. Ask exactly ONE high-signal clarifying question (with 2-4 options and your ' +
                        'recommended default first). Use this when one answer would unblock planning.\n' +
                        'Never implement, never edit files, never run effectful tools. Planning mode is STICKY: ' +
                        '"do/fix/build" all mean "plan X" here, not "implement X". Set planner.routed when you ' +
                        'have routed to #planner or asked the question.',
                    outputKey: 'planner.routed',
                },
            },
            {
                id: 'memory',
                kind: 'memory',
                label: 'Recall relevant session context',
                config: { op: 'set', key: 'memory.loaded', value: true },
            },
            {
                id: 'maturity-check',
                kind: 'llm',
                label: 'Assess codebase maturity and existing patterns before implementing',
                capabilities: ['read'],
                config: {
                    systemPrompt:
                        'Before following existing patterns, assess whether they are worth following. Sample ' +
                        'config files (linter, formatter, type config) and 2-3 similar files. Classify the ' +
                        'codebase state and record it so downstream nodes follow the right discipline:\n' +
                        '- disciplined (consistent patterns, configs present, tests exist) -> follow existing ' +
                        'style strictly.\n' +
                        '- transitional (mixed patterns, some structure) -> note which pattern to follow.\n' +
                        '- legacy (no consistency, outdated patterns) -> propose an approach, do not copy.\n' +
                        '- greenfield (new/empty) -> apply modern best practices.\n' +
                        'If the codebase looks undisciplined, verify before assuming — different patterns may ' +
                        'serve different purposes intentionally. Write the classification to explore.maturity.',
                    outputKey: 'explore.maturity',
                },
            },
            {
                id: 'anti-dup-guard',
                kind: 'llm',
                label: 'Anti-dup exploration guard and delegation-bias check',
                config: {
                    systemPrompt:
                        'Two checks before delegation:\n' +
                        '1. ANTI-DUP: if the work was already explored (check prior exploration results in ' +
                        'context), do NOT re-explore the same ground. Skip redundant exploration and proceed ' +
                        'with what is already known. Re-running the same searches wastes tokens and can ' +
                        'contradict earlier findings.\n' +
                        '2. DELEGATION-BIAS: assess whether delegation is appropriate. Is the task small enough ' +
                        'to do directly with certainty? Is there an existing pattern to follow (per the maturity ' +
                        'check)? Default bias is DELEGATE for non-trivial work, but trivial single-file work ' +
                        'you can do correctly yourself should be done directly rather than over-delegated.\n' +
                        'Set guard.cleared=true when both checks pass and the plan may proceed to todo planning.',
                    outputKey: 'guard.cleared',
                    outputShape: 'boolean',
                },
            },
            {
                id: 'todo-plan',
                kind: 'llm',
                label: 'Decompose explicit task into ordered todos',
                config: {
                    systemPrompt:
                        'Break the task into small ordered todo items (one implementation+test unit per todo). ' +
                        'Store the list in plan.todos and set plan.ready when complete. Each todo should be ' +
                        'atomic enough to delegate as one sub-task.',
                    outputKey: 'plan.ready',
                },
            },
            {
                id: 'delegate-wave',
                kind: 'parallel',
                label: 'Fan out task() delegation per todo',
                children: ['delegate-worker'],
                config: { fanOutKey: 'plan.todos', completionKey: 'delegate.complete' },
            },
            {
                id: 'delegate-worker',
                kind: 'llm',
                label: 'Single task() delegation',
                capabilities: ['task'],
                config: {
                    systemPrompt:
                        'Execute the delegated sub-task via the task tool. Frame the delegation with TASK, ' +
                        'EXPECTED OUTCOME, REQUIRED TOOLS, MUST DO, MUST NOT DO, and CONTEXT.',
                },
            },
            {
                id: 'verify-wave',
                kind: 'llm',
                implementation: 'critic',
                label: 'Critic — verify delegate results against requirements',
                config: { evaluateKey: 'delegate.results', outputKey: 'critic.passed' },
            },
            {
                id: 'evidence-check',
                kind: 'llm',
                label: 'Evidence check — verify concrete evidence, not just child claims',
                config: {
                    systemPrompt:
                        'Personal verification after delegation. Do NOT trust the child\'s "done" claim alone. ' +
                        'Verify concrete evidence: lsp_diagnostics clean on changed files, build exit code 0, ' +
                        'test run passing, expected file changes present, command output matching. Confirm the ' +
                        'work followed MUST DO / MUST NOT DO requirements and existing codebase patterns. ' +
                        'NO EVIDENCE = NOT COMPLETE. Set evidence.verified=true only when concrete evidence ' +
                        'confirms the work; set evidence.verified=false to trigger a bounded retry.',
                    outputKey: 'evidence.verified',
                    outputShape: 'boolean',
                },
            },
            {
                id: 'supervisor',
                kind: 'llm',
                implementation: 'supervisor',
                label: '3-strike failure recovery — retry under budget, else escalate',
                config: { maxAttempts: DEFAULT_WORKFLOW_STRIKE_BUDGET, strikeBudget: DEFAULT_WORKFLOW_STRIKE_BUDGET },
            },
            {
                id: 'final-respond',
                kind: 'llm',
                label: 'Synthesize final answer citing evidence',
                config: {
                    systemPrompt:
                        'Synthesize the final answer from verified results. Cite the evidence that was checked ' +
                        '(files changed, tests passing, build status, command output). Do not claim completion ' +
                        'beyond what the evidence supports; surface pre-existing failures unrelated to this work ' +
                        'as notes rather than fixing them.',
                },
            },
            {
                id: 'clarify',
                kind: 'llm',
                label: 'Ask ONE clarifying question — ambiguous prompts',
                config: {
                    systemPrompt:
                        'Ask the user exactly ONE targeted clarifying question. Name what you understood, what ' +
                        'you are unsure about, 2-4 options with effort/implications, and your recommendation. ' +
                        'Set clarify.active when clarification is collected.',
                    outputKey: 'clarify.active',
                },
            },
        ],
        edges: [
            { source: 'intent-gate', target: 'direct-respond', condition: 'intent-trivial', priority: 30 },
            { source: 'intent-gate', target: 'research-explore', condition: 'intent-exploratory', priority: 25 },
            { source: 'intent-gate', target: 'route-planner', condition: 'intent-open-ended', priority: 22 },
            { source: 'intent-gate', target: 'memory', condition: 'intent-explicit-implementation', priority: 20 },
            { source: 'intent-gate', target: 'clarify', condition: 'intent-ambiguous', priority: 10 },
            { source: 'intent-gate', target: 'intent-gate', condition: 'llm-loop-active', priority: 5 },
            { source: 'direct-respond', target: 'direct-respond', condition: 'llm-loop-active', priority: 10 },
            { source: 'research-explore', target: 'final-respond', condition: 'research-complete', priority: 10 },
            { source: 'research-explore', target: 'research-explore', condition: 'llm-loop-active', priority: 5 },
            { source: 'route-planner', target: 'final-respond', condition: 'planner-routed', priority: 10 },
            { source: 'route-planner', target: 'route-planner', condition: 'llm-loop-active', priority: 5 },
            { source: 'memory', target: 'maturity-check', condition: 'memory-loaded', priority: 10 },
            { source: 'maturity-check', target: 'anti-dup-guard', condition: 'maturity-assessed', priority: 10 },
            { source: 'anti-dup-guard', target: 'todo-plan', condition: 'guard-cleared', priority: 10 },
            { source: 'todo-plan', target: 'delegate-wave', condition: 'plan-ready', priority: 10 },
            { source: 'todo-plan', target: 'todo-plan', condition: 'llm-loop-active', priority: 5 },
            { source: 'delegate-wave', target: 'verify-wave', condition: 'wave-complete', priority: 10 },
            { source: 'delegate-worker', target: 'delegate-worker', condition: 'llm-loop-active', priority: 5 },
            { source: 'verify-wave', target: 'evidence-check', condition: 'critic-passed', priority: 20 },
            { source: 'verify-wave', target: 'supervisor', condition: 'critic-failed', priority: 10 },
            { source: 'evidence-check', target: 'final-respond', condition: 'evidence-verified', priority: 20 },
            { source: 'evidence-check', target: 'supervisor', condition: 'evidence-missing', priority: 10 },
            { source: 'supervisor', target: 'delegate-wave', condition: 'supervisor-retry', priority: 10 },
            { source: 'supervisor', target: 'final-respond', condition: 'supervisor-escalated', priority: 20 },
            { source: 'final-respond', target: 'final-respond', condition: 'llm-loop-active', priority: 5 },
            { source: 'clarify', target: 'intent-gate', condition: 'clarify-loop', priority: 10 },
            { source: 'clarify', target: 'clarify', condition: 'llm-loop-active', priority: 5 },
        ],
        rules: [
            {
                id: 'intent-trivial',
                description: 'intent classified as trivial',
                when: { kind: 'blackboard.value.equals', key: 'intent.classification', value: 'trivial' },
            },
            {
                id: 'intent-exploratory',
                description: 'intent classified as exploratory-research',
                when: {
                    kind: 'blackboard.value.equals',
                    key: 'intent.classification',
                    value: 'exploratory-research',
                },
            },
            {
                id: 'intent-open-ended',
                description: 'intent classified as open-ended-planning',
                when: {
                    kind: 'blackboard.value.equals',
                    key: 'intent.classification',
                    value: 'open-ended-planning',
                },
            },
            {
                id: 'intent-explicit-implementation',
                description: 'intent classified as explicit-implementation',
                when: {
                    kind: 'blackboard.value.equals',
                    key: 'intent.classification',
                    value: 'explicit-implementation',
                },
            },
            {
                id: 'intent-ambiguous',
                description: 'intent classified as ambiguous',
                when: { kind: 'blackboard.value.equals', key: 'intent.classification', value: 'ambiguous' },
            },
            {
                id: 'llm-loop-active',
                description: 'llm node re-enters while it proposes tool calls',
                when: { kind: 'blackboard.value.equals', key: 'llm.loop_active', value: true },
            },
            {
                id: 'memory-loaded',
                description: 'context memory loaded',
                when: { kind: 'blackboard.value.equals', key: 'memory.loaded', value: true },
            },
            {
                id: 'maturity-assessed',
                description: 'codebase maturity assessed',
                when: { kind: 'blackboard.key.exists', key: 'explore.maturity' },
            },
            {
                id: 'guard-cleared',
                description: 'anti-dup and delegation-bias checks passed',
                when: { kind: 'blackboard.value.equals', key: 'guard.cleared', value: true },
            },
            {
                id: 'research-complete',
                description: 'exploratory research synthesis ready',
                when: { kind: 'blackboard.key.exists', key: 'explore.complete' },
            },
            {
                id: 'planner-routed',
                description: 'routed to #planner or asked one question',
                when: { kind: 'blackboard.key.exists', key: 'planner.routed' },
            },
            {
                id: 'plan-ready',
                description: 'todo plan produced',
                when: { kind: 'blackboard.key.exists', key: 'plan.ready' },
            },
            {
                id: 'wave-complete',
                description: 'delegation wave finished',
                when: { kind: 'blackboard.key.exists', key: 'delegate.complete' },
            },
            {
                id: 'critic-passed',
                description: 'verify-wave critic approved results',
                when: { kind: 'blackboard.value.equals', key: 'critic.passed', value: true },
            },
            {
                id: 'critic-failed',
                description: 'verify-wave critic rejected results',
                when: { kind: 'blackboard.value.equals', key: 'critic.passed', value: false },
            },
            {
                id: 'evidence-verified',
                description: 'concrete evidence confirmed the delegated work',
                when: { kind: 'blackboard.value.equals', key: 'evidence.verified', value: true },
            },
            {
                id: 'evidence-missing',
                description: 'evidence check failed — trigger bounded retry',
                when: { kind: 'blackboard.value.equals', key: 'evidence.verified', value: false },
            },
            {
                id: 'supervisor-retry',
                description: 'supervisor decided to retry delegation (under strike budget)',
                when: { kind: 'blackboard.value.equals', key: 'supervisor.action', value: 'retry' },
            },
            {
                id: 'supervisor-escalated',
                description: 'supervisor escalated after exhausting the 3-strike budget',
                when: { kind: 'blackboard.key.exists', key: 'supervisor.escalated' },
            },
            {
                id: 'clarify-loop',
                description: 'clarification collected — re-classify intent',
                when: { kind: 'blackboard.value.equals', key: 'clarify.active', value: true },
            },
        ],
        policies: [],
    };
}
