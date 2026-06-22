/**
 * The planner workflow graph (plan Task 3.1, ABG Round 8 decomposition).
 *
 *   intake -> assess-ambiguity -> {
 *     clear         -> explore -> draft-plan -> review-plan -> present
 *     unclear       -> research -> adopt-defaults -> draft-plan -> review-plan -> ...
 *     on-the-fence  -> ask-one-question -> assess-ambiguity (re-classify)
 *   }
 *
 * The planner is READ-ONLY: it may only write plan artifacts to `.omo/plans/` and spec
 * artifacts to `.omo/specs/`. The read-only enforcement is declared as a built-in mode
 * (`PLANNER_READONLY_MODE`) on the {@linkcode WorkflowSpec} wrapper — its `policies` use the
 * `PolicyEffectRule` shape (action/resource/effect) consumed by the Task 1.2 rule evaluator.
 * The graph's own `policies` array stays empty because the planner's nodes are `llm`-kind and
 * do not declare destructive capabilities directly; tool-level writes are gated dynamically via
 * the policy-gate node path (Task 3.2).
 *
 * Routing mirrors `default-workflow-graph.ts`: each LLM node declares `config.outputKey`, every
 * edge is gated by a `blackboard.value.equals` rule on that key, and the critic retry loop
 * (review-plan -> draft-plan) uses the `plan.approved` boolean just like the default's
 * `critic.passed`.
 */
import type { AbgGraphSpec, AbgNodeModelOptions, Mode, PolicyEffectRule } from '@mission-control/protocol';

export const PLANNER_WORKFLOW_GRAPH_ID = 'planner';
export const PLANNER_WORKFLOW_MAX_NODE_RUNS = 32;
export const PLANNER_READONLY_MODE_ID = 'planner-readonly';

const PLANNER_MODEL: AbgNodeModelOptions = {
    providerID: 'local',
    modelID: 'local-echo',
};

/**
 * Read-only policies carried by the {@linkcode PLANNER_READONLY_MODE}. Last-match-wins semantics
 * (Task 1.2 `rule-evaluator.ts`): the broad `write **` deny fires first, then the specific
 * `.omo/plans/**` and `.omo/specs/**` allows override it for those paths.
 */
export const PLANNER_READONLY_POLICIES: readonly PolicyEffectRule[] = [
    { action: 'write', resource: '**', effect: 'deny' },
    { action: 'write', resource: '.omo/plans/**', effect: 'allow' },
    { action: 'write', resource: '.omo/specs/**', effect: 'allow' },
];

/**
 * Built-in read-only mode declared on the planner `WorkflowSpec`. At materialization (Task 3.8)
 * its overlay prompt and policies are merged into the graph's llm-actor nodes and policy-gate
 * rules so the planner cannot mutate source files.
 */
export const PLANNER_READONLY_MODE: Mode = {
    id: PLANNER_READONLY_MODE_ID,
    systemPromptOverlay:
        'You are a PLANNER. You are READ-ONLY. You must not edit source files. ' +
        'You may only write plan artifacts to .omo/plans/ and spec artifacts to .omo/specs/. ' +
        'When the request is ambiguous, ask at most ONE high-signal clarifying question.',
    policies: [...PLANNER_READONLY_POLICIES],
};

export type PlannerWorkflowGraphOptions = {
    /** Provider/model the LLM nodes resolve via the runner's `resolveSdkModel`. Defaults to local/local-echo. */
    readonly model?: AbgNodeModelOptions;
    /** Graph loop bound. Default 32. */
    readonly maxNodeRuns?: number;
};

export function createPlannerWorkflowGraph(options: PlannerWorkflowGraphOptions = {}): AbgGraphSpec {
    const model: AbgNodeModelOptions = options.model ?? PLANNER_MODEL;
    return {
        id: PLANNER_WORKFLOW_GRAPH_ID,
        version: '0.1.0',
        entryNodeId: 'intake',
        defaults: {
            model,
            maxNodeRuns: options.maxNodeRuns ?? PLANNER_WORKFLOW_MAX_NODE_RUNS,
        },
        nodes: [
            {
                id: 'intake',
                kind: 'llm',
                label: 'Capture the planning request and summarize the goal',
                config: {
                    systemPrompt:
                        'Summarize the user planning request into a concise goal statement. Set intake.complete when done.',
                    outputKey: 'intake.complete',
                },
            },
            {
                id: 'assess-ambiguity',
                kind: 'llm',
                label: 'Ambiguity gate — clear | unclear | on-the-fence',
                config: {
                    systemPrompt:
                        'Classify the request ambiguity as "clear" (well-specified, proceed), "unclear" (needs research before planning), or "on-the-fence" (one clarifying question resolves it). Write the label to ambiguity.classification.',
                    outputKey: 'ambiguity.classification',
                },
            },
            {
                id: 'explore',
                kind: 'llm',
                label: 'Explore the codebase to ground the plan',
                capabilities: ['read'],
                config: {
                    systemPrompt:
                        'Explore the relevant codebase areas to ground the plan in real structure. Set explore.complete when exploration is done.',
                    outputKey: 'explore.complete',
                },
            },
            {
                id: 'research',
                kind: 'llm',
                label: 'Research best practices for an unclear request',
                capabilities: ['read'],
                config: {
                    systemPrompt:
                        'Research best practices and prior art to make the unclear request plannable. Set research.complete when research is done.',
                    outputKey: 'research.complete',
                },
            },
            {
                id: 'adopt-defaults',
                kind: 'llm',
                label: 'Adopt documented defaults to resolve ambiguity',
                config: {
                    systemPrompt:
                        'Adopt reasonable, documented defaults so the request becomes plannable without further clarification. Set defaults.adopted when complete.',
                    outputKey: 'defaults.adopted',
                },
            },
            {
                id: 'ask-one-question',
                kind: 'llm',
                label: 'Ask exactly ONE high-signal clarifying question',
                config: {
                    systemPrompt:
                        'Ask exactly ONE clarifying question whose answer disambiguates the request. Set clarify.answered when the user responds.',
                    outputKey: 'clarify.answered',
                },
            },
            {
                id: 'draft-plan',
                kind: 'llm',
                label: 'Draft the plan as .omo/plans/{slug}.md',
                capabilities: ['read'],
                config: {
                    systemPrompt:
                        'Draft the plan as a .omo/plans/{slug}.md checklist with a TL;DR, ordered TODOs, and a Final Verification Wave. Set plan.drafted when the plan is written.',
                    outputKey: 'plan.drafted',
                },
            },
            {
                id: 'review-plan',
                kind: 'llm',
                implementation: 'critic',
                label: 'Critic — review plan completeness and feasibility',
                config: {
                    evaluateKey: 'plan.draft',
                    outputKey: 'plan.approved',
                },
            },
            {
                id: 'present',
                kind: 'llm',
                label: 'Present the finalized plan with file path and summary',
            },
        ],
        edges: [
            { source: 'intake', target: 'assess-ambiguity', priority: 10 },
            { source: 'assess-ambiguity', target: 'explore', condition: 'ambiguity-clear', priority: 30 },
            { source: 'assess-ambiguity', target: 'research', condition: 'ambiguity-unclear', priority: 20 },
            {
                source: 'assess-ambiguity',
                target: 'ask-one-question',
                condition: 'ambiguity-on-the-fence',
                priority: 10,
            },
            { source: 'explore', target: 'draft-plan', condition: 'explore-complete', priority: 10 },
            { source: 'research', target: 'adopt-defaults', condition: 'research-complete', priority: 10 },
            { source: 'adopt-defaults', target: 'draft-plan', condition: 'defaults-adopted', priority: 10 },
            { source: 'ask-one-question', target: 'assess-ambiguity', condition: 'question-answered', priority: 10 },
            { source: 'draft-plan', target: 'review-plan', condition: 'plan-drafted', priority: 10 },
            { source: 'review-plan', target: 'present', condition: 'plan-approved', priority: 20 },
            { source: 'review-plan', target: 'draft-plan', condition: 'plan-rejected', priority: 10 },
        ],
        rules: [
            {
                id: 'ambiguity-clear',
                description: 'ambiguity classified as clear',
                when: { kind: 'blackboard.value.equals', key: 'ambiguity.classification', value: 'clear' },
            },
            {
                id: 'ambiguity-unclear',
                description: 'ambiguity classified as unclear',
                when: { kind: 'blackboard.value.equals', key: 'ambiguity.classification', value: 'unclear' },
            },
            {
                id: 'ambiguity-on-the-fence',
                description: 'ambiguity classified as on-the-fence',
                when: { kind: 'blackboard.value.equals', key: 'ambiguity.classification', value: 'on-the-fence' },
            },
            {
                id: 'explore-complete',
                description: 'codebase exploration finished',
                when: { kind: 'blackboard.value.equals', key: 'explore.complete', value: true },
            },
            {
                id: 'research-complete',
                description: 'best-practice research finished',
                when: { kind: 'blackboard.value.equals', key: 'research.complete', value: true },
            },
            {
                id: 'defaults-adopted',
                description: 'documented defaults adopted',
                when: { kind: 'blackboard.value.equals', key: 'defaults.adopted', value: true },
            },
            {
                id: 'question-answered',
                description: 'clarifying question answered — re-classify',
                when: { kind: 'blackboard.value.equals', key: 'clarify.answered', value: true },
            },
            {
                id: 'plan-drafted',
                description: 'plan drafted to .omo/plans/{slug}.md',
                when: { kind: 'blackboard.value.equals', key: 'plan.drafted', value: true },
            },
            {
                id: 'plan-approved',
                description: 'review-plan critic approved the plan',
                when: { kind: 'blackboard.value.equals', key: 'plan.approved', value: true },
            },
            {
                id: 'plan-rejected',
                description: 'review-plan critic rejected the plan — revise',
                when: { kind: 'blackboard.value.equals', key: 'plan.approved', value: false },
            },
        ],
        policies: [],
    };
}
