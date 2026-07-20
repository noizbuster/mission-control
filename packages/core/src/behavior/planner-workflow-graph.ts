// allow: SIZE_OK -- deep autonomous planner-workflow graph; one declarative graph whose routing tables are reviewed together.
/**
 * The planner workflow graph — deep autonomous planning craft.
 *
 *   intake -> resume-gate -> {
 *     resume_approval -> approval-gate
 *     resume_drafting -> draft-plan
 *     fresh           -> assess-ambiguity -> intent-bridge -> {
 *       clear         -> explore-filter -> {
 *                          needs-exploration -> explore -> interview-loop
 *                          direct-draft      -> interview-loop
 *                       }
 *                       interview-loop -> {
 *                          continue   -> interview-loop
 *                          clear      -> draft-plan
 *                          cap_adopt  -> adopt-defaults-announce -> draft-plan
 *                       }
 *       unclear       -> research -> adopt-defaults -> draft-plan
 *       on-the-fence  -> ask-one-question -> assess-ambiguity (re-classify)
 *     }
 *   }
 *   draft-plan (writes .omo/drafts/<slug>.md, plan.drafted)
 *     -> draft-frontmatter (status=drafting + intent/review_required)
 *     -> review-plan (deterministic critic floor) -> {
 *          rejected (critic.passed false) -> draft-plan
 *        | approved (critic.passed true)  -> metis-gap (LLM, metis.passed) -> {
 *              false -> metis-reject-gate { revise -> draft-plan | escalate_present -> present-blocked }
 *            | true  -> dual-review-route { dual.route skip|run } -> {
 *                  skip -> draft-awaiting-approval -> approval-gate
 *                | run  -> dual-review-wave (reviewer+oracle task children, all-approve dual.verdict)
 *                     ├─ APPROVE -> draft-awaiting-approval (receipts) -> approval-gate
 *                     └─ REJECT  -> dual-fix-gate { dual.fixes budget 1; receipts on draft }
 *                          ├─ revise    -> draft-plan (reset metis.rejects=0)
 *                          └─ escalate  -> present-blocked
 *              }
 *          }
 *        }
 *   approval-gate (blocks for explicit okay, plan.ready)
 *     -> write-plan (writes .omo/plans/<slug>.md scaffold) -> present
 *
 * Deep planning semantics: goal-oriented (objectives not recipes), explore
 * hierarchy before any question (tools → explore agents via task → only then
 * multi-turn interview on the clear path, max 6 turns then cap_adopt), never
 * stop early, produce an execution-ready plan with verification strategy.
 * Sticky plan mode (never implements product code), approval-gated draft state,
 * scaffold-compatible output, and independently constrained read-only child
 * consultations.
 *
 * allow: SIZE_OK — indivisible declarative graph spec. The factory returns one
 * object that `planner-workflow-graph.test.ts` asserts is byte-identical to
 * `examples/abg/planner.workflow.json` via `toEqual`.
 */
import type { AbgGraphSpec, AbgNodeModelOptions, Mode, PolicyEffectRule } from '@mission-control/protocol';
import { PLANNER_SCAFFOLD_HEADERS } from '../persistence/plan-scaffold';
import {
    DUAL_FIX_ROUTE_VALUES,
    DUAL_ROUTE_VALUES,
    PLANNER_DUAL_FIX_BUDGET,
} from './planner-dual-review';
import { PLANNER_MAX_INTERVIEW_TURNS } from './planner-interview';
import { METIS_REJECT_ROUTE_VALUES, PLANNER_METIS_REJECT_BUDGET } from './planner-metis';

export { PLANNER_SCAFFOLD_HEADERS };
export {
    PLANNER_MAX_INTERVIEW_TURNS,
    INTERVIEW_ROUTE_VALUES,
    detectInterviewForce,
    INTERVIEW_FORCE_MARKERS,
    routeInterview,
    type InterviewRoute,
    type RouteInterviewInput,
} from './planner-interview';
export {
    METIS_REJECT_ROUTE_VALUES,
    PLANNER_METIS_REJECT_BUDGET,
    routeMetisReject,
    type MetisRejectRoute,
} from './planner-metis';
export {
    DUAL_FIX_ROUTE_VALUES,
    DUAL_INTENT_VALUES,
    DUAL_ROUTE_VALUES,
    PLANNER_DUAL_FIX_BUDGET,
    routeDualReview,
    routeFixDual,
    type DualFixRoute,
    type DualIntent,
    type DualRoute,
    type RouteDualReviewInput,
} from './planner-dual-review';

/** Parallel all-approve strategy for dual-review-wave (mirrors executer final wave). */
export const PLANNER_DUAL_VERDICT_STRATEGY_ALL_APPROVE = 'all-approve';

export const PLANNER_WORKFLOW_GRAPH_ID = 'planner';
export const PLANNER_WORKFLOW_MAX_NODE_RUNS = 100;
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
        'You are a senior staff engineer planning craft — deep autonomous planning. Plan mode is ' +
        'STICKY: "do X" / "fix X" / "build X" / "just do it" all mean "plan X". You NEVER implement ' +
        'product code and NEVER begin execution — that belongs to #executer (or #executer) or an ' +
        'explicit start command. You are READ-ONLY: you must not edit source files. You may only write plan ' +
        'artifacts to .omo/plans/, spec artifacts to .omo/specs/, and draft artifacts to ' +
        '.omo/drafts/. Goal-oriented: optimize for objectives and outcomes, not recipe steps. ' +
        'Explore hierarchy before any question: (1) use read tools yourself, (2) delegate ' +
        'explore/librarian agents via task when breadth is needed, (3) only then ask ONE ' +
        'high-signal clarifying question as a last resort. Never stop early — produce an ' +
        'execution-ready plan with verification strategy. When intent is fuzzy research best ' +
        'practices and ANNOUNCE adopted defaults instead of interrogating.',
    policies: [...PLANNER_READONLY_POLICIES],
};

/**
 * Review-plan deterministic floor contract (plan Task 8 / T5). APPROVE-BIASED
 * executability floor only: the review-plan node runs the deterministic `critic`
 * implementation in draft-heuristic mode (no `evaluateKey`), so a draft is
 * rejected only when it is empty, cites no file:line evidence, or is a non-answer.
 * Stricter Strict plan gap analysis lives on the separate `metis-gap` LLM node.
 */
export const PLANNER_REVIEW_GAP_ANALYSIS_PROMPT =
    'You are the plan review critic for deep autonomous planning. Review the latest draft for ' +
    'EXECUTABILITY and completeness of verification strategy, not perfection. APPROVE-BIAS: ' +
    'approve unless you find a concrete blocker (a plan that is 80% clear is good enough; the ' +
    'user approver and the executer handle minor gaps). GAP ANALYSIS — reject (critic.passed=false) ' +
    'ONLY when one of these concrete blockers is present: (1) MISSING REFERENCES — a todo cites ' +
    'a file:line that does not exist or points at unrelated content; (2) MISSING QA SCENARIOS — ' +
    'a todo lacks QA scenarios, or the scenarios are unexecutable ("verify it works", "check the ' +
    'page") with no tool, concrete steps, and expected result; (3) MISSING ACCEPTANCE CRITERIA — ' +
    'a todo has no agent-executable acceptance criteria; (4) MISSING SCAFFOLD HEADERS — the draft ' +
    'omits ## Todos or ## Final Verification Wave; (5) MISSING VERIFICATION STRATEGY — the plan ' +
    'has no concrete way an executor can prove success. When rejecting, name the SINGLE most ' +
    'critical blocker concisely so draft-plan can revise. Do NOT reject for stylistic ' +
    'preferences, edge-case completeness, or subjective "could be clearer" notes — those are ' +
    'NOT blockers. HIGH-ACCURACY DUAL REVIEW (two independent critics comparing verdicts) is ' +
    'NOT run here by default; it is an opt-in cross-check offered AFTER the plan is delivered. ' +
    'Do not block the handoff waiting for it. The deterministic checks run alongside this ' +
    'prompt reject empty drafts, drafts that cite no file:line evidence, and non-answers; a ' +
    'draft that is non-empty, cites real references, and is a genuine plan passes.';

/**
 * Gap-analysis LLM prompt. Stricter than the deterministic review-plan
 * floor: rejects drafts that pass the floor but still lack concrete refs, QA
 * scenarios, acceptance criteria, scaffold headers, or a verification strategy.
 * Output is the whole-output boolean for `metis.passed` only.
 */
export const PLANNER_METIS_GAP_PROMPT =
    'You are the strict plan gap-analysis critic for deep autonomous planning. The ' +
    'deterministic floor already confirmed the draft is non-empty, cites file:line evidence, and ' +
    'is not a non-answer. Your job is STRICTER gap analysis. Reject (metis.passed=false) when ANY ' +
    'of these concrete gaps is present: (1) MISSING or weak REFERENCES — todos lack real file:line ' +
    'anchors or cite unrelated content; (2) MISSING QA SCENARIOS — a todo lacks happy+failure QA ' +
    'with tool, concrete steps, and expected result (vague "verify it works" fails); (3) MISSING ' +
    'ACCEPTANCE CRITERIA — a todo has no agent-executable acceptance criteria; (4) MISSING SCAFFOLD ' +
    'HEADERS — draft omits ## Todos or ## Final Verification Wave; (5) MISSING VERIFICATION ' +
    'STRATEGY — no concrete way an executor can prove success (tests, diagnostics, manual QA ' +
    'surface). Prefer reject over approve when a gap is real. When rejecting, name the SINGLE most ' +
    'critical gap so draft-plan can revise. Output ONLY the JSON boolean `true` if the draft ' +
    'passes every check, or `false` if any gap remains — no prose, no formatting, no extra text.';

/** Terminal prompt when gap-analysis reject budget or dual-fix budget is exhausted. */
export const PLANNER_PRESENT_BLOCKED_PROMPT =
    'Planning is blocked: either gap analysis exhausted metis.rejects, or dual-review ' +
    '(reviewer+oracle) exhausted dual.fixes after REJECT. Present a clear blocked summary: name ' +
    'which gate blocked (gap-analysis vs dual-review), the last critical gap or dual verdicts if known, ' +
    'and tell the user what to change or how to resume. Do NOT write .omo/plans/, do NOT implement ' +
    'product code, and do NOT loop back into draft-plan. This node is terminal.';

/**
 * Dual-review child prompt: fixed agent via task(), whole-output APPROVE|REJECT.
 * Receipts: best-effort append `## Dual review receipts` on the draft when revising.
 */
export const PLANNER_DUAL_REVIEWER_PROMPT =
    'You are the dual-review REVIEWER lane for deep autonomous planning. Call task() exactly once ' +
    'with agent="reviewer" and an assignment that reviews the latest draft for executability, ' +
    'references, QA scenarios, acceptance criteria, and verification strategy. After the child ' +
    'returns, output ONLY one whole-output verdict — APPROVE or REJECT — with no prose or ' +
    'formatting. Prefer REJECT when a concrete blocker remains. Do not implement product code.';

export const PLANNER_DUAL_ORACLE_PROMPT =
    'You are the dual-review ORACLE lane for deep autonomous planning. Call task() exactly once ' +
    'with agent="oracle" and an assignment that independently reviews the latest draft for ' +
    'architectural soundness, missing risks, and whether the plan is execution-ready. After the ' +
    'child returns, output ONLY one whole-output verdict — APPROVE or REJECT — with no prose or ' +
    'formatting. Prefer REJECT when a concrete blocker remains. Do not implement product code.';

/** Context injected into explore/research prompts before read-only delegation. */
export const PLANNER_READONLY_CHILD_CONTEXT =
    'Planner-readonly applies to these workflow nodes after mode materialization. Spawned child ' +
    'agents do NOT inherit workflow PolicyEffectRule sets; their authority is independently ' +
    'constrained by the selected read-only category and AgentDefinition.pathPolicies. Delegate only ' +
    'to explore/librarian, frame child prompts as read-only research (TASK / DELIVERABLE / SCOPE / ' +
    'VERIFY), and treat subagent output as claims until verified.';

export type PlannerWorkflowGraphOptions = {
    /**
     * Provider/model pin for the graph's `defaults.model`. When omitted, the
     * graph does NOT declare a default model; the runtime resolves each LLM
     * node's model from the session's `modelProviderSelection` at `runContext`
     * time. Pass an explicit model only when a graph should override the
     * session provider.
     */
    readonly model?: AbgNodeModelOptions;
    /** Graph loop bound. Default 100. */
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
            // Progress-contract exhaust: pure conditional gates re-admit under budget, then
            // escalate to present (never silent graph.completed). Recovery only — sticky
            // plan-first product policy is unchanged.
            escalationTarget: 'present',
        },
        nodes: [
            {
                id: 'intake',
                kind: 'llm',
                label: 'Capture the planning request and summarize the goal',
                config: {
                    systemPrompt:
                        'You are a senior staff engineer planning craft. Summarize the user request ' +
                        'into a concise GOAL statement (objective and success outcome, not a recipe). ' +
                        'Even if the user says "do", "fix", or "build", you PLAN the work — you do not ' +
                        'implement it. Note optional slug:<name> tokens, high-accuracy markers ' +
                        '("high accuracy", "ultra high accuracy", "고정밀", "deep review"), and ' +
                        'interview-force markers ("interview me", "ask me", "왜 안 물어") for the ' +
                        'deterministic resume-gate that follows. Set intake.complete when done.',
                    outputKey: 'intake.complete',
                },
            },
            {
                id: 'resume-gate',
                kind: 'llm',
                implementation: 'resume-gate',
                label: 'Resume gate — draft frontmatter enum (fresh | resume_approval | resume_drafting)',
                // Deterministic pure runner: empty capabilities keep pureStructuredGate true.
                capabilities: [],
                config: {
                    outputKey: 'resume_gate',
                    outputEnum: ['fresh', 'resume_approval', 'resume_drafting'],
                },
            },
            {
                id: 'assess-ambiguity',
                kind: 'llm',
                label: 'Ambiguity gate (filter 1) — clear | unclear | on-the-fence',
                // Pure routing gate: empty capabilities keep pureStructuredGate true.
                capabilities: [],
                config: {
                    systemPrompt:
                        'Classify the request ambiguity for deep autonomous planning. Write exactly ' +
                        'one label to ambiguity.classification: "clear" (the desired outcome is ' +
                        'well-specified; only preferences/tradeoffs remain), "unclear" (the outcome ' +
                        'itself is fuzzy; research and adopt best-practice defaults), or ' +
                        '"on-the-fence" (one clarifying question resolves it — last resort after ' +
                        'tools and explore agents). Prefer exploring over asking. Mis-routing a clear ' +
                        'request to unclear silently overrides forks the user wanted to own — when ' +
                        'genuinely unsure, prefer clear.',
                    outputKey: 'ambiguity.classification',
                    outputEnum: ['clear', 'unclear', 'on-the-fence'],
                },
            },
            {
                id: 'intent-bridge',
                kind: 'llm',
                implementation: 'intent-bridge',
                label: 'Intent bridge — clear|unclear classification → blackboard intent',
                capabilities: [],
                config: {},
            },
            {
                id: 'explore-filter',
                kind: 'llm',
                label: 'Exploration gate (filter 2) — needs-exploration | direct-draft',
                // Pure routing gate: empty capabilities keep pureStructuredGate true.
                capabilities: [],
                config: {
                    systemPrompt:
                        'Second filter within the clear branch. Decide whether the plan must be ' +
                        'grounded in codebase exploration first, or whether the request is trivial ' +
                        'enough to draft directly. Write exactly one label to explore.decision: ' +
                        '"needs-exploration" (the plan touches real structure that must be cited) or ' +
                        '"direct-draft" (the request is self-contained, e.g. a one-line change). ' +
                        'Default to "needs-exploration" when in doubt — deep planning explores before ' +
                        'drafting and before asking.',
                    outputKey: 'explore.decision',
                    outputEnum: ['needs-exploration', 'direct-draft'],
                },
            },
            {
                id: 'explore',
                kind: 'llm',
                label: 'Explore the codebase to ground the plan',
                capabilities: ['read'],
                config: {
                    systemPrompt:
                        'Deep exploration to ground an execution-ready plan. Hierarchy: (1) use read ' +
                        'tools yourself first, (2) when breadth is needed delegate explore/librarian ' +
                        'via task with TASK / DELIVERABLE / SCOPE / VERIFY framing, (3) never ask the ' +
                        'user during this node. Cite file:line evidence for every claim. ' +
                        PLANNER_READONLY_CHILD_CONTEXT +
                        ' Multi-turn: keep going until exploration is grounded — do not stop early. ' +
                        'While exploring, call tools and do NOT output true. When ready, synthesize ' +
                        'findings. Output ONLY the JSON boolean `true` when complete — no prose, no ' +
                        'formatting, no extra text.',
                    outputKey: 'explore.complete',
                    outputShape: 'boolean',
                },
            },
            {
                id: 'interview-loop',
                kind: 'llm',
                label: 'Multi-turn interview — continue | clear | cap_adopt',
                // Pure routing gate: empty capabilities keep pureStructuredGate true.
                capabilities: [],
                config: {
                    systemPrompt:
                        'Multi-turn interview on the clear planning path. Ask high-signal owner ' +
                        'decisions only after exploration (or when exploration was skippable). Track ' +
                        'interview turns; max ' +
                        String(PLANNER_MAX_INTERVIEW_TURNS) +
                        ' turns then route cap_adopt. When interview.force is true, do NOT auto-default ' +
                        'owner decisions — keep interviewing until the user clears or the cap is hit. ' +
                        'Write exactly one whole-output label to interview.route: "continue" (more ' +
                        'questions needed), "clear" (enough to draft), or "cap_adopt" (turn cap reached; ' +
                        'adopt remaining defaults). Output ONLY that enum label — no prose, no ' +
                        'formatting, no extra text.',
                    outputKey: 'interview.route',
                    outputEnum: ['continue', 'clear', 'cap_adopt'],
                },
            },
            {
                id: 'adopt-defaults-announce',
                kind: 'llm',
                label: 'Announce adopted defaults after interview turn cap',
                config: {
                    systemPrompt:
                        'Interview turn cap reached. Briefly announce each remaining default you are ' +
                        'adopting (with rationale and reversibility) so the user can see what was ' +
                        'assumed after the interview budget. Then set interview.defaults_announced ' +
                        'when the announcement is complete so drafting can proceed.',
                    outputKey: 'interview.defaults_announced',
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
                        'defaults (industry standard or repo convention) with rationale. Prefer tools ' +
                        'and explore/librarian agents over questions. ' +
                        PLANNER_READONLY_CHILD_CONTEXT +
                        ' Multi-turn: keep going until research is grounded — do not stop early. While ' +
                        'researching, call tools and do NOT output true. When ready, synthesize findings. ' +
                        'Output ONLY the JSON boolean `true` when complete — no prose, no formatting, no ' +
                        'extra text.',
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
                        'Goal-oriented: choose defaults that maximize the stated objective. The only ' +
                        'default escalated to a question is one that is irreversible, destructive, or ' +
                        'safety-critical and research cannot settle. Set defaults.adopted when complete.',
                    outputKey: 'defaults.adopted',
                },
            },
            {
                id: 'ask-one-question',
                kind: 'llm',
                label: 'Ask exactly ONE high-signal clarifying question',
                config: {
                    systemPrompt:
                        'LAST RESORT only: ask exactly ONE clarifying question whose answer ' +
                        'disambiguates the request. You must already have exhausted tools and ' +
                        'explore/librarian agents. Name what you explored, why it did not resolve, ' +
                        'and which part of the plan forks on the answer. Provide 2-4 options with ' +
                        'your recommended default first. Set clarify.answered when the user responds.',
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
                        'Draft an execution-ready plan as .omo/drafts/<slug>.md. This is the DRAFT, ' +
                        'not the final plan — it is the durable, compaction-safe resume point. Goal-' +
                        'oriented: state objectives, topology ledger (1-6 independently-succeed/fail ' +
                        'components), verification strategy, adopted defaults, and the pending ' +
                        'approval gate. Never stop early — every todo must be agent-executable with ' +
                        'references and acceptance criteria. Do NOT write .omo/plans/<slug>.md yet — ' +
                        'that is gated on explicit approval. Set plan.drafted when the draft is written.',
                    outputKey: 'plan.drafted',
                },
            },
            {
                id: 'draft-frontmatter',
                kind: 'llm',
                implementation: 'draft-frontmatter',
                label: 'Write draft frontmatter status=drafting + intent/review_required',
                capabilities: [],
                config: {
                    status: 'drafting',
                },
            },
            {
                id: 'review-plan',
                kind: 'llm',
                implementation: 'critic',
                label: 'Critic floor — approve-biased executability checks',
                config: {
                    systemPrompt: PLANNER_REVIEW_GAP_ANALYSIS_PROMPT,
                    outputKey: 'plan.approved',
                },
            },
            {
                id: 'metis-gap',
                kind: 'llm',
                label: 'Strict plan gap analysis — stricter refs/QA/acceptance/headers/verification',
                // Structured boolean writer (no custom implementation): bi-coverage applies.
                capabilities: [],
                config: {
                    systemPrompt: PLANNER_METIS_GAP_PROMPT,
                    outputKey: 'metis.passed',
                    outputShape: 'boolean',
                },
            },
            {
                id: 'metis-reject-gate',
                kind: 'llm',
                implementation: 'metis-reject-gate',
                label: 'Gap-analysis reject budget — revise once then escalate to present-blocked',
                // Deterministic pure runner: empty capabilities keep pureStructuredGate true.
                capabilities: [],
                config: {
                    outputKey: 'metis.reject_route',
                    outputEnum: [...METIS_REJECT_ROUTE_VALUES],
                    rejectKey: 'metis.rejects',
                    rejectBudget: PLANNER_METIS_REJECT_BUDGET,
                },
            },
            {
                id: 'present-blocked',
                kind: 'llm',
                label: 'Terminal — gap-analysis or dual-review budget exhausted; present blocked summary',
                capabilities: [],
                config: {
                    systemPrompt: PLANNER_PRESENT_BLOCKED_PROMPT,
                },
            },
            {
                id: 'dual-review-route',
                kind: 'llm',
                implementation: 'dual-review-route',
                label: 'Dual-review route — skip when clear && !review_required; else run',
                // Deterministic pure runner: empty capabilities keep pureStructuredGate true.
                capabilities: [],
                config: {
                    outputKey: 'dual.route',
                    outputEnum: [...DUAL_ROUTE_VALUES],
                },
            },
            {
                id: 'dual-review-wave',
                kind: 'parallel',
                label: 'Dual-review wave — reviewer + oracle task children, all-approve dual.verdict',
                children: ['dual-reviewer', 'dual-oracle'],
                config: {
                    completionKey: 'dual.complete',
                    verdictKey: 'dual.verdict',
                    verdictStrategy: PLANNER_DUAL_VERDICT_STRATEGY_ALL_APPROVE,
                    verdictSources: ['dual.reviewer', 'dual.oracle'],
                    aggregateKey: 'dual.critics',
                },
            },
            {
                id: 'dual-reviewer',
                kind: 'llm',
                label: 'Dual-review reviewer lane — task(agent=reviewer) → dual.reviewer',
                capabilities: ['subagent'],
                config: {
                    systemPrompt: PLANNER_DUAL_REVIEWER_PROMPT,
                    outputKey: 'dual.reviewer',
                    outputEnum: ['APPROVE', 'REJECT'],
                },
            },
            {
                id: 'dual-oracle',
                kind: 'llm',
                label: 'Dual-review oracle lane — task(agent=oracle) → dual.oracle',
                capabilities: ['subagent'],
                config: {
                    systemPrompt: PLANNER_DUAL_ORACLE_PROMPT,
                    outputKey: 'dual.oracle',
                    outputEnum: ['APPROVE', 'REJECT'],
                },
            },
            {
                id: 'dual-fix-gate',
                kind: 'llm',
                implementation: 'dual-fix-gate',
                label: 'Dual-fix budget — revise once (reset metis.rejects) then escalate',
                // Deterministic pure runner: empty capabilities keep pureStructuredGate true.
                capabilities: [],
                config: {
                    outputKey: 'dual.fix_route',
                    outputEnum: [...DUAL_FIX_ROUTE_VALUES],
                    fixKey: 'dual.fixes',
                    fixBudget: PLANNER_DUAL_FIX_BUDGET,
                    metisRejectKey: 'metis.rejects',
                },
            },
            {
                id: 'draft-awaiting-approval',
                kind: 'llm',
                implementation: 'draft-frontmatter',
                label: 'Write draft frontmatter status=awaiting-approval (+ dual receipts when present)',
                capabilities: [],
                config: {
                    status: 'awaiting-approval',
                    appendDualReceipts: true,
                },
            },
            {
                id: 'approval-gate',
                kind: 'llm',
                label: 'Approval gate — block for explicit okay before the final plan',
                // Pure boolean gate: empty capabilities keep pureStructuredGate true.
                capabilities: [],
                config: {
                    systemPrompt:
                        'Present the approval brief ONCE: what you found (key facts with paths), the ' +
                        'approach, and every surviving owner-decision with your recommended option. ' +
                        "Then WAIT for the user's explicit okay. Approval authorizes writing the plan " +
                        "ONLY — it is NEVER authorization to implement. Read the user's next reply as " +
                        'a decision: approve, scope-change (revise the draft, re-present), or still-unclear ' +
                        '(emit one short line, do not re-explore). Output ONLY the JSON boolean `true` when the ' +
                        'user explicitly approves, or `false` otherwise — no prose, no formatting, no extra text.',
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
                        'Only reached AFTER approval. Write the final execution-ready plan to ' +
                        '.omo/plans/<slug>.md with the scaffold headers in order: ' +
                        PLANNER_SCAFFOLD_HEADERS.join(' | ') +
                        '. Under Scope state explicit Must have / Must NOT have. Under Verification ' +
                        'Strategy name how success is proven (tests, diagnostics, manual QA surface). ' +
                        'Under Todos use "- [ ]" checkboxes, one Implementation+Test unit per todo, ' +
                        'each with References, agent-executable Acceptance criteria, happy+failure QA ' +
                        'scenarios, and a Commit line. Under Final Verification Wave list F1 ' +
                        'plan-compliance, F2 code-quality, F3 real manual QA, F4 scope-fidelity. Near ' +
                        'the top emit a "Status: Approved" line so the executer admission gate can ' +
                        'verify the plan was explicitly approved before any task delegation. Set ' +
                        'plan.written when the final plan is committed.',
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
            { source: 'intake', target: 'resume-gate', priority: 10 },
            {
                source: 'resume-gate',
                target: 'approval-gate',
                condition: 'resume-approval',
                priority: 30,
            },
            {
                source: 'resume-gate',
                target: 'draft-plan',
                condition: 'resume-drafting',
                priority: 20,
            },
            {
                source: 'resume-gate',
                target: 'assess-ambiguity',
                condition: 'resume-fresh',
                priority: 10,
            },
            { source: 'assess-ambiguity', target: 'intent-bridge', priority: 10 },
            { source: 'intent-bridge', target: 'explore-filter', condition: 'ambiguity-clear', priority: 30 },
            { source: 'intent-bridge', target: 'research', condition: 'ambiguity-unclear', priority: 20 },
            {
                source: 'intent-bridge',
                target: 'ask-one-question',
                condition: 'ambiguity-on-the-fence',
                priority: 10,
            },
            { source: 'explore-filter', target: 'explore', condition: 'exploration-needed', priority: 20 },
            {
                source: 'explore-filter',
                target: 'interview-loop',
                condition: 'exploration-skippable',
                priority: 10,
            },
            { source: 'explore', target: 'interview-loop', condition: 'explore-complete', priority: 10 },
            {
                source: 'interview-loop',
                target: 'interview-loop',
                condition: 'interview-continue',
                priority: 30,
            },
            {
                source: 'interview-loop',
                target: 'draft-plan',
                condition: 'interview-clear',
                priority: 20,
            },
            {
                source: 'interview-loop',
                target: 'adopt-defaults-announce',
                condition: 'interview-cap-adopt',
                priority: 10,
            },
            {
                source: 'adopt-defaults-announce',
                target: 'draft-plan',
                condition: 'interview-defaults-announced',
                priority: 10,
            },
            { source: 'research', target: 'adopt-defaults', condition: 'research-complete', priority: 10 },
            { source: 'adopt-defaults', target: 'draft-plan', condition: 'defaults-adopted', priority: 10 },
            { source: 'ask-one-question', target: 'assess-ambiguity', condition: 'question-answered', priority: 10 },
            { source: 'draft-plan', target: 'draft-frontmatter', condition: 'plan-drafted', priority: 10 },
            { source: 'draft-frontmatter', target: 'review-plan', priority: 10 },
            { source: 'review-plan', target: 'metis-gap', condition: 'plan-approved', priority: 20 },
            { source: 'review-plan', target: 'draft-plan', condition: 'plan-rejected', priority: 10 },
            { source: 'metis-gap', target: 'dual-review-route', condition: 'metis-passed', priority: 20 },
            { source: 'metis-gap', target: 'metis-reject-gate', condition: 'metis-failed', priority: 10 },
            {
                source: 'metis-reject-gate',
                target: 'draft-plan',
                condition: 'metis-revise',
                priority: 20,
            },
            {
                source: 'metis-reject-gate',
                target: 'present-blocked',
                condition: 'metis-escalate-present',
                priority: 10,
            },
            {
                source: 'dual-review-route',
                target: 'draft-awaiting-approval',
                condition: 'dual-skip',
                priority: 20,
            },
            {
                source: 'dual-review-route',
                target: 'dual-review-wave',
                condition: 'dual-run',
                priority: 10,
            },
            {
                source: 'dual-review-wave',
                target: 'draft-awaiting-approval',
                condition: 'dual-approved',
                priority: 20,
            },
            {
                source: 'dual-review-wave',
                target: 'dual-fix-gate',
                condition: 'dual-rejected',
                priority: 10,
            },
            {
                source: 'dual-fix-gate',
                target: 'draft-plan',
                condition: 'dual-revise',
                priority: 20,
            },
            {
                source: 'dual-fix-gate',
                target: 'present-blocked',
                condition: 'dual-escalate',
                priority: 10,
            },
            { source: 'draft-awaiting-approval', target: 'approval-gate', priority: 10 },
            { source: 'approval-gate', target: 'write-plan', condition: 'plan-ready', priority: 20 },
            { source: 'approval-gate', target: 'approval-gate', condition: 'plan-awaiting-approval', priority: 10 },
            { source: 'write-plan', target: 'present', condition: 'plan-written', priority: 10 },
            { source: 'intake', target: 'intake', condition: 'llm-loop-active', priority: 5 },
            { source: 'assess-ambiguity', target: 'assess-ambiguity', condition: 'llm-loop-active', priority: 5 },
            { source: 'explore-filter', target: 'explore-filter', condition: 'llm-loop-active', priority: 5 },
            { source: 'explore', target: 'explore', condition: 'llm-loop-active', priority: 5 },
            { source: 'interview-loop', target: 'interview-loop', condition: 'llm-loop-active', priority: 5 },
            {
                source: 'adopt-defaults-announce',
                target: 'adopt-defaults-announce',
                condition: 'llm-loop-active',
                priority: 5,
            },
            { source: 'research', target: 'research', condition: 'llm-loop-active', priority: 5 },
            { source: 'adopt-defaults', target: 'adopt-defaults', condition: 'llm-loop-active', priority: 5 },
            { source: 'ask-one-question', target: 'ask-one-question', condition: 'llm-loop-active', priority: 5 },
            { source: 'draft-plan', target: 'draft-plan', condition: 'llm-loop-active', priority: 5 },
            { source: 'review-plan', target: 'review-plan', condition: 'llm-loop-active', priority: 5 },
            { source: 'metis-gap', target: 'metis-gap', condition: 'llm-loop-active', priority: 5 },
            { source: 'dual-reviewer', target: 'dual-reviewer', condition: 'llm-loop-active', priority: 5 },
            { source: 'dual-oracle', target: 'dual-oracle', condition: 'llm-loop-active', priority: 5 },
            { source: 'approval-gate', target: 'approval-gate', condition: 'llm-loop-active', priority: 5 },
            { source: 'write-plan', target: 'write-plan', condition: 'llm-loop-active', priority: 5 },
            { source: 'present', target: 'present', condition: 'llm-loop-active', priority: 5 },
            { source: 'present-blocked', target: 'present-blocked', condition: 'llm-loop-active', priority: 5 },
        ],
        rules: [
            {
                id: 'llm-loop-active',
                description: 'LLM node re-enters while it proposes tool calls',
                when: { kind: 'blackboard.value.equals', key: 'llm.loop_active', value: true },
            },
            {
                id: 'resume-approval',
                description: 'draft frontmatter status is awaiting-approval — resume at approval-gate',
                when: { kind: 'blackboard.value.equals', key: 'resume_gate', value: 'resume_approval' },
            },
            {
                id: 'resume-drafting',
                description: 'draft frontmatter status is drafting with body — resume at draft-plan',
                when: { kind: 'blackboard.value.equals', key: 'resume_gate', value: 'resume_drafting' },
            },
            {
                id: 'resume-fresh',
                description: 'no resumable draft — continue through assess-ambiguity',
                when: { kind: 'blackboard.value.equals', key: 'resume_gate', value: 'fresh' },
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
                description: 'clear request is trivial enough to skip exploration and enter interview',
                when: { kind: 'blackboard.value.equals', key: 'explore.decision', value: 'direct-draft' },
            },
            {
                id: 'explore-complete',
                description: 'codebase exploration finished — enter interview-loop',
                when: { kind: 'blackboard.value.equals', key: 'explore.complete', value: true },
            },
            {
                id: 'interview-continue',
                description: 'interview needs another turn',
                when: { kind: 'blackboard.value.equals', key: 'interview.route', value: 'continue' },
            },
            {
                id: 'interview-clear',
                description: 'interview cleared — draft the plan',
                when: { kind: 'blackboard.value.equals', key: 'interview.route', value: 'clear' },
            },
            {
                id: 'interview-cap-adopt',
                description: 'interview turn cap reached — announce adopted defaults',
                when: { kind: 'blackboard.value.equals', key: 'interview.route', value: 'cap_adopt' },
            },
            {
                id: 'interview-defaults-announced',
                description: 'post-cap defaults announced — draft the plan',
                when: {
                    kind: 'blackboard.value.equals',
                    key: 'interview.defaults_announced',
                    value: true,
                },
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
                description: 'review-plan critic floor approved the draft — enter metis-gap',
                when: { kind: 'blackboard.value.equals', key: 'critic.passed', value: true },
            },
            {
                id: 'plan-rejected',
                description: 'review-plan critic rejected the draft — revise',
                when: { kind: 'blackboard.value.equals', key: 'critic.passed', value: false },
            },
            {
                id: 'metis-passed',
                description: 'metis-gap approved the draft — enter dual-review-route',
                when: { kind: 'blackboard.value.equals', key: 'metis.passed', value: true },
            },
            {
                id: 'metis-failed',
                description: 'metis-gap rejected the draft — enter metis-reject-gate',
                when: { kind: 'blackboard.value.equals', key: 'metis.passed', value: false },
            },
            {
                id: 'metis-revise',
                description: 'metis reject under budget — revise draft-plan',
                when: { kind: 'blackboard.value.equals', key: 'metis.reject_route', value: 'revise' },
            },
            {
                id: 'metis-escalate-present',
                description: 'metis reject budget exhausted — present-blocked terminal',
                when: {
                    kind: 'blackboard.value.equals',
                    key: 'metis.reject_route',
                    value: 'escalate_present',
                },
            },
            {
                id: 'dual-skip',
                description: 'dual-review skipped (clear intent and review_required false) — approval-gate',
                when: { kind: 'blackboard.value.equals', key: 'dual.route', value: 'skip' },
            },
            {
                id: 'dual-run',
                description: 'dual-review required — enter dual-review-wave',
                when: { kind: 'blackboard.value.equals', key: 'dual.route', value: 'run' },
            },
            {
                id: 'dual-approved',
                description: 'dual-review all-approve — continue to approval-gate',
                when: { kind: 'blackboard.value.equals', key: 'dual.verdict', value: 'APPROVE' },
            },
            {
                id: 'dual-rejected',
                description: 'dual-review rejected — enter dual-fix-gate',
                when: { kind: 'blackboard.value.equals', key: 'dual.verdict', value: 'REJECT' },
            },
            {
                id: 'dual-revise',
                description: 'dual-fix under budget — revise draft-plan (metis.rejects reset)',
                when: { kind: 'blackboard.value.equals', key: 'dual.fix_route', value: 'revise' },
            },
            {
                id: 'dual-escalate',
                description: 'dual-fix budget exhausted — present-blocked terminal',
                when: { kind: 'blackboard.value.equals', key: 'dual.fix_route', value: 'escalate' },
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
