/**
 * The planner workflow graph (plan Task 7 — Prometheus planner mechanics).
 *
 *   intake -> assess-ambiguity -> {
 *     clear         -> explore-filter -> {
 *                        needs-exploration -> explore -> draft-plan
 *                        direct-draft      -> draft-plan
 *                     }
 *     unclear       -> research -> adopt-defaults -> draft-plan
 *     on-the-fence  -> ask-one-question -> assess-ambiguity (re-classify)
 *   }
 *   draft-plan (writes .omo/drafts/<slug>.md, plan.drafted)
 *     -> review-plan -> { approved -> approval-gate, rejected -> draft-plan }
 *   approval-gate (blocks for explicit okay, plan.ready)
 *     -> write-plan (writes .omo/plans/<slug>.md scaffold) -> present
 *
 * Ported Prometheus semantics: sticky plan mode (never implements), explore-
 * before-asking, two-filter routing, approval-gated draft state, scaffold-
 * compatible output, planner-readonly child consultations. See the reference
 * ulw-plan skill for the behavioral spec; no reference code is imported.
 *
 * allow: SIZE_OK — indivisible declarative graph spec. The factory returns one
 * object that `planner-workflow-graph.test.ts` asserts is byte-identical to
 * `examples/abg/planner.workflow.json` via `toEqual`. Sibling graph factories
 * (default: 181 LOC, runner: 223 LOC) follow the same data-table pattern; this
 * one is larger because the Prometheus mechanics add nodes (explore-filter,
 * approval-gate, write-plan) and richer prompts.
 */
import type { AbgGraphSpec, AbgNodeModelOptions, Mode, PolicyEffectRule } from '@mission-control/protocol';

export const PLANNER_WORKFLOW_GRAPH_ID = 'planner';
export const PLANNER_WORKFLOW_MAX_NODE_RUNS = 32;
export const PLANNER_READONLY_MODE_ID = 'planner-readonly';

/**
 * Read-only policies carried by the {@linkcode PLANNER_READONLY_MODE}.
 * Last-match-wins semantics (Task 1.2 `rule-evaluator.ts`): the broad
 * `write **` deny fires first, then the specific allows override it for the
 * plan-artifact paths.
 *
 * `.omo/drafts/**` is allowed because the approval-gated draft state writes
 * `.omo/drafts/<slug>.md` before the final plan handoff (Task 7). It stays
 * inside `.omo/` and opens no product-source paths.
 */
export const PLANNER_READONLY_POLICIES: readonly PolicyEffectRule[] = [
    { action: 'write', resource: '**', effect: 'deny' },
    { action: 'write', resource: '.omo/plans/**', effect: 'allow' },
    { action: 'write', resource: '.omo/specs/**', effect: 'allow' },
    { action: 'write', resource: '.omo/drafts/**', effect: 'allow' },
];

/**
 * Built-in read-only mode declared on the planner `WorkflowSpec`. At
 * materialization (Task 3.8) its overlay prompt and policies are merged into
 * the graph's llm-actor nodes and policy-gate rules so the planner cannot
 * mutate source files. The overlay enforces sticky plan mode: even "do / fix
 * / build" requests produce a PLAN, never implementation.
 */
export const PLANNER_READONLY_MODE: Mode = {
    id: PLANNER_READONLY_MODE_ID,
    systemPromptOverlay:
        'You are a PLANNER (Prometheus-style). Plan mode is STICKY: "do X" / "fix X" / ' +
        '"build X" / "just do it" all mean "plan X". You NEVER implement product code and NEVER ' +
        'begin execution — that belongs to #runner or an explicit start command. You are READ-ONLY: ' +
        'you must not edit source files. You may only write plan artifacts to .omo/plans/, spec ' +
        'artifacts to .omo/specs/, and draft artifacts to .omo/drafts/. Explore the codebase before ' +
        'asking; when a request is ambiguous ask at most ONE high-signal clarifying question; when ' +
        'intent is fuzzy research best practices and ANNOUNCE adopted defaults instead of interrogating.',
    policies: [...PLANNER_READONLY_POLICIES],
};

/**
 * The scaffold headers write-plan emits into `.omo/plans/<slug>.md`. Kept in
 * one place so the parity test and any future scaffold helper share one
 * definition. Mirrors the existing `.omo/plans/*.md` format.
 */
export const PLANNER_SCAFFOLD_HEADERS: readonly string[] = [
    '# <slug> - Work Plan',
    '## TL;DR (For humans)',
    '## Scope',
    '## Verification Strategy',
    '## Execution Strategy',
    '## Todos',
    '## Final Verification Wave',
    '## Commit Strategy',
    '## Success Criteria',
];

/**
 * Review-plan gap-analysis contract (plan Task 8 — Metis/Momus-style review
 * semantics, documented equivalent). The review is APPROVE-BIASED: it approves
 * unless it finds a concrete blocker (the Momus "approve unless verifiably
 * broken" stance). It documents the full gap analysis (missing references, QA
 * scenarios, acceptance criteria, scaffold headers) as the review contract.
 *
 * The review-plan node runs the deterministic `critic` implementation in
 * draft-heuristic mode (no `evaluateKey`), so `defaultCriticChecks` enforce the
 * approve-biased executability floor at runtime — a draft is rejected only when
 * it is empty, cites no file:line evidence, or is a non-answer. This prompt is
 * the documented contract for a future LLM-backed critic and for graph readers.
 *
 * HIGH-ACCURACY DUAL REVIEW is explicitly opt-in AFTER plan delivery: it is not
 * run by default for CLEAR intent and must not block the handoff.
 */
export const PLANNER_REVIEW_GAP_ANALYSIS_PROMPT =
    'You are the plan review critic (Metis/Momus-style). Review the latest draft for ' +
    'EXECUTABILITY, not perfection. APPROVE-BIAS: approve unless you find a concrete blocker ' +
    '(a plan that is 80% clear is good enough; the user approver and the runner handle minor ' +
    'gaps). GAP ANALYSIS — reject (critic.passed=false) ONLY when one of these concrete ' +
    'blockers is present: (1) MISSING REFERENCES — a todo cites a file:line that does not ' +
    'exist or points at unrelated content; (2) MISSING QA SCENARIOS — a todo lacks QA ' +
    'scenarios, or the scenarios are unexecutable ("verify it works", "check the page") with ' +
    'no tool, concrete steps, and expected result; (3) MISSING ACCEPTANCE CRITERIA — a todo ' +
    'has no agent-executable acceptance criteria; (4) MISSING SCAFFOLD HEADERS — the draft ' +
    'omits ## Todos or ## Final Verification Wave. When rejecting, name the SINGLE most ' +
    'critical blocker concisely so draft-plan can revise. Do NOT reject for stylistic ' +
    'preferences, edge-case completeness, or subjective "could be clearer" notes — those are ' +
    'NOT blockers. HIGH-ACCURACY DUAL REVIEW (two independent critics comparing verdicts) is ' +
    'NOT run here by default; it is an opt-in cross-check offered AFTER the plan is delivered. ' +
    'Do not block the handoff waiting for it. The deterministic checks run alongside this ' +
    'prompt reject empty drafts, drafts that cite no file:line evidence, and non-answers; a ' +
    'draft that is non-empty, cites real references, and is a genuine plan passes.';

/** Context injected into explore/research prompts for planner-readonly children. */
export const PLANNER_READONLY_CHILD_CONTEXT =
    'You are operating under planner-readonly. Any child agent you delegate to ' +
    '(explore/librarian) INHERITS the planner-readonly boundary: it may NOT write outside ' +
    '.omo/plans/**, .omo/specs/**, and .omo/drafts/**. Frame child prompts as read-only research ' +
    '(TASK / DELIVERABLE / SCOPE / VERIFY) and treat subagent output as claims until verified.';

export type PlannerWorkflowGraphOptions = {
    /**
     * Provider/model pin for the graph's `defaults.model`. When omitted, the
     * graph does NOT declare a default model; the runtime resolves each LLM
     * node's model from the session's `modelProviderSelection` at `runContext`
     * time. Pass an explicit model only when a graph should override the
     * session provider.
     */
    readonly model?: AbgNodeModelOptions;
    /** Graph loop bound. Default 32. */
    readonly maxNodeRuns?: number;
};

export function createPlannerWorkflowGraph(options: PlannerWorkflowGraphOptions = {}): AbgGraphSpec {
    return {
        id: PLANNER_WORKFLOW_GRAPH_ID,
        version: '0.1.0',
        entryNodeId: 'intake',
        defaults: {
            ...(options.model !== undefined ? { model: options.model } : {}),
            maxNodeRuns: options.maxNodeRuns ?? PLANNER_WORKFLOW_MAX_NODE_RUNS,
        },
        nodes: [
            {
                id: 'intake',
                kind: 'llm',
                label: 'Capture the planning request and summarize the goal',
                config: {
                    systemPrompt:
                        'Summarize the user planning request into a concise goal statement. ' +
                        'You are a PLANNER — even if the user says "do", "fix", or "build", you PLAN ' +
                        'the work, you do not implement it. Set intake.complete when done.',
                    outputKey: 'intake.complete',
                },
            },
            {
                id: 'assess-ambiguity',
                kind: 'llm',
                label: 'Ambiguity gate (filter 1) — clear | unclear | on-the-fence',
                config: {
                    systemPrompt:
                        'Classify the request ambiguity. Write exactly one label to ' +
                        'ambiguity.classification: "clear" (the desired outcome is well-specified; ' +
                        'only preferences/tradeoffs remain), "unclear" (the outcome itself is fuzzy; ' +
                        'research and adopt best-practice defaults), or "on-the-fence" (one ' +
                        'clarifying question resolves it). Mis-routing a clear request to unclear ' +
                        'silently overrides forks the user wanted to own — when genuinely unsure, ' +
                        'prefer clear.',
                    outputKey: 'ambiguity.classification',
                },
            },
            {
                id: 'explore-filter',
                kind: 'llm',
                label: 'Exploration gate (filter 2) — needs-exploration | direct-draft',
                config: {
                    systemPrompt:
                        'Second filter within the clear branch. Decide whether the plan must be ' +
                        'grounded in codebase exploration first, or whether the request is trivial ' +
                        'enough to draft directly. Write exactly one label to explore.decision: ' +
                        '"needs-exploration" (the plan touches real structure that must be cited) or ' +
                        '"direct-draft" (the request is self-contained, e.g. a one-line change). ' +
                        'Default to "needs-exploration" when in doubt — explore before asking.',
                    outputKey: 'explore.decision',
                },
            },
            {
                id: 'explore',
                kind: 'llm',
                label: 'Explore the codebase to ground the plan',
                capabilities: ['read'],
                config: {
                    systemPrompt:
                        'Explore the relevant codebase areas to ground the plan in real structure. ' +
                        'Cite file:line evidence for every claim. ' +
                        PLANNER_READONLY_CHILD_CONTEXT +
                        ' Multi-turn: keep calling tools until exploration is grounded. While exploring, ' +
                        'call tools and do NOT output true. When ready, synthesize findings, then on the ' +
                        'LAST line output EXACTLY `true` (boolean) — no quotes, no formatting, no extra text.',
                    outputKey: 'explore.complete',
                    outputShape: 'boolean',
                },
            },
            {
                id: 'research',
                kind: 'llm',
                label: 'Research best practices for an unclear request',
                capabilities: ['read'],
                config: {
                    systemPrompt:
                        'The request outcome is fuzzy. Research best practices and prior art to make ' +
                        'it plannable WITHOUT interrogating the user — adopt and ANNOUNCE defensible ' +
                        'defaults (industry standard or repo convention) with rationale. ' +
                        PLANNER_READONLY_CHILD_CONTEXT +
                        ' Multi-turn: keep calling tools until research is grounded. While researching, ' +
                        'call tools and do NOT output true. When ready, synthesize findings, then on the ' +
                        'LAST line output EXACTLY `true` (boolean) — no quotes, no formatting, no extra text.',
                    outputKey: 'research.complete',
                    outputShape: 'boolean',
                },
            },
            {
                id: 'adopt-defaults',
                kind: 'llm',
                label: 'Adopt documented defaults to resolve ambiguity',
                config: {
                    systemPrompt:
                        'Record each adopted best-practice default with rationale and reversibility. ' +
                        'The only default escalated to a question is one that is irreversible, ' +
                        'destructive, or safety-critical and research cannot settle. Set ' +
                        'defaults.adopted when complete.',
                    outputKey: 'defaults.adopted',
                },
            },
            {
                id: 'ask-one-question',
                kind: 'llm',
                label: 'Ask exactly ONE high-signal clarifying question',
                config: {
                    systemPrompt:
                        'Ask exactly ONE clarifying question whose answer disambiguates the request. ' +
                        'Name what you explored, why it did not resolve, and which part of the plan ' +
                        'forks on the answer. Provide 2-4 options with your recommended default first. ' +
                        'Set clarify.answered when the user responds.',
                    outputKey: 'clarify.answered',
                },
            },
            {
                id: 'draft-plan',
                kind: 'llm',
                label: 'Draft the plan to .omo/drafts/{slug}.md',
                capabilities: ['read', 'write'],
                config: {
                    systemPrompt:
                        'Draft the plan as .omo/drafts/<slug>.md. This is the DRAFT, not the final ' +
                        'plan — it is the durable, compaction-safe resume point. Record the topology ' +
                        'ledger (1-6 independently-succeed/fail components), adopted defaults, and the ' +
                        'pending approval gate. Do NOT write .omo/plans/<slug>.md yet — that is gated ' +
                        'on explicit approval. Set plan.drafted when the draft is written.',
                    outputKey: 'plan.drafted',
                },
            },
            {
                id: 'review-plan',
                kind: 'llm',
                implementation: 'critic',
                label: 'Critic — review draft completeness, references, and QA',
                config: {
                    systemPrompt: PLANNER_REVIEW_GAP_ANALYSIS_PROMPT,
                    outputKey: 'plan.approved',
                },
            },
            {
                id: 'approval-gate',
                kind: 'llm',
                label: 'Approval gate — block for explicit okay before the final plan',
                config: {
                    systemPrompt:
                        'Present the approval brief ONCE: what you found (key facts with paths), the ' +
                        'approach, and every surviving owner-decision with your recommended option. ' +
                        "Then WAIT for the user's explicit okay. Approval authorizes writing the plan " +
                        "ONLY — it is NEVER authorization to implement. Read the user's next reply as " +
                        'a decision: approve, scope-change (revise the draft, re-present), or still-unclear ' +
                        '(emit one short line, do not re-explore). ' +
                        'On the LAST line, output EXACTLY `true` when the user explicitly approves, or ' +
                        '`false` otherwise — no quotes, no formatting, no extra text.',
                    outputKey: 'plan.ready',
                    outputShape: 'boolean',
                },
            },
            {
                id: 'write-plan',
                kind: 'llm',
                label: 'Write the scaffold-compatible final plan to .omo/plans/{slug}.md',
                capabilities: ['read', 'write'],
                config: {
                    systemPrompt:
                        'Only reached AFTER approval. Write the final plan to .omo/plans/<slug>.md ' +
                        'with the scaffold headers in order: ' +
                        PLANNER_SCAFFOLD_HEADERS.join(' | ') +
                        '. Under Scope state explicit Must have / Must NOT have. Under Todos use ' +
                        '"- [ ]" checkboxes, one Implementation+Test unit per todo, each with ' +
                        'References, agent-executable Acceptance criteria, happy+failure QA scenarios, ' +
                        'and a Commit line. Under Final Verification Wave list F1 plan-compliance, ' +
                        'F2 code-quality, F3 real manual QA, F4 scope-fidelity. Near the top emit a ' +
                        '"Status: Approved" line so the runner admission gate can verify the plan was ' +
                        'explicitly approved before any task delegation. Set plan.written when the ' +
                        'final plan is committed.',
                    outputKey: 'plan.written',
                },
            },
            {
                id: 'present',
                kind: 'llm',
                label: 'Present the finalized plan with file path and summary',
                capabilities: [],
            },
        ],
        edges: [
            { source: 'intake', target: 'assess-ambiguity', priority: 10 },
            { source: 'assess-ambiguity', target: 'explore-filter', condition: 'ambiguity-clear', priority: 30 },
            { source: 'assess-ambiguity', target: 'research', condition: 'ambiguity-unclear', priority: 20 },
            {
                source: 'assess-ambiguity',
                target: 'ask-one-question',
                condition: 'ambiguity-on-the-fence',
                priority: 10,
            },
            { source: 'explore-filter', target: 'explore', condition: 'exploration-needed', priority: 20 },
            { source: 'explore-filter', target: 'draft-plan', condition: 'exploration-skippable', priority: 10 },
            { source: 'explore', target: 'draft-plan', condition: 'explore-complete', priority: 10 },
            { source: 'research', target: 'adopt-defaults', condition: 'research-complete', priority: 10 },
            { source: 'adopt-defaults', target: 'draft-plan', condition: 'defaults-adopted', priority: 10 },
            { source: 'ask-one-question', target: 'assess-ambiguity', condition: 'question-answered', priority: 10 },
            { source: 'draft-plan', target: 'review-plan', condition: 'plan-drafted', priority: 10 },
            { source: 'review-plan', target: 'approval-gate', condition: 'plan-approved', priority: 20 },
            { source: 'review-plan', target: 'draft-plan', condition: 'plan-rejected', priority: 10 },
            { source: 'approval-gate', target: 'write-plan', condition: 'plan-ready', priority: 20 },
            { source: 'approval-gate', target: 'approval-gate', condition: 'plan-awaiting-approval', priority: 10 },
            { source: 'write-plan', target: 'present', condition: 'plan-written', priority: 10 },
            { source: 'intake', target: 'intake', condition: 'llm-loop-active', priority: 5 },
            { source: 'assess-ambiguity', target: 'assess-ambiguity', condition: 'llm-loop-active', priority: 5 },
            { source: 'explore-filter', target: 'explore-filter', condition: 'llm-loop-active', priority: 5 },
            { source: 'explore', target: 'explore', condition: 'llm-loop-active', priority: 5 },
            { source: 'research', target: 'research', condition: 'llm-loop-active', priority: 5 },
            { source: 'adopt-defaults', target: 'adopt-defaults', condition: 'llm-loop-active', priority: 5 },
            { source: 'ask-one-question', target: 'ask-one-question', condition: 'llm-loop-active', priority: 5 },
            { source: 'draft-plan', target: 'draft-plan', condition: 'llm-loop-active', priority: 5 },
            { source: 'review-plan', target: 'review-plan', condition: 'llm-loop-active', priority: 5 },
            { source: 'approval-gate', target: 'approval-gate', condition: 'llm-loop-active', priority: 5 },
            { source: 'write-plan', target: 'write-plan', condition: 'llm-loop-active', priority: 5 },
            { source: 'present', target: 'present', condition: 'llm-loop-active', priority: 5 },
        ],
        rules: [
            {
                id: 'llm-loop-active',
                description: 'LLM node re-enters while it proposes tool calls',
                when: { kind: 'blackboard.value.equals', key: 'llm.loop_active', value: true },
            },
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
                id: 'exploration-needed',
                description: 'clear request needs codebase exploration before drafting',
                when: { kind: 'blackboard.value.equals', key: 'explore.decision', value: 'needs-exploration' },
            },
            {
                id: 'exploration-skippable',
                description: 'clear request is trivial enough to draft directly',
                when: { kind: 'blackboard.value.equals', key: 'explore.decision', value: 'direct-draft' },
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
                when: { kind: 'blackboard.key.exists', key: 'defaults.adopted' },
            },
            {
                id: 'question-answered',
                description: 'clarifying question answered — re-classify',
                when: { kind: 'blackboard.key.exists', key: 'clarify.answered' },
            },
            {
                id: 'plan-drafted',
                description: 'draft written to .omo/drafts/<slug>.md',
                when: { kind: 'blackboard.key.exists', key: 'plan.drafted' },
            },
            {
                id: 'plan-approved',
                description: 'review-plan critic approved the draft',
                when: { kind: 'blackboard.value.equals', key: 'critic.passed', value: true },
            },
            {
                id: 'plan-rejected',
                description: 'review-plan critic rejected the draft — revise',
                when: { kind: 'blackboard.value.equals', key: 'critic.passed', value: false },
            },
            {
                id: 'plan-ready',
                description: 'user explicitly approved — write the final plan',
                when: { kind: 'blackboard.value.equals', key: 'plan.ready', value: true },
            },
            {
                id: 'plan-awaiting-approval',
                description: 'approval gate waiting for explicit okay',
                when: { kind: 'blackboard.value.equals', key: 'plan.ready', value: false },
            },
            {
                id: 'plan-written',
                description: 'final plan written to .omo/plans/<slug>.md',
                when: { kind: 'blackboard.key.exists', key: 'plan.written' },
            },
        ],
        policies: [],
    };
}
