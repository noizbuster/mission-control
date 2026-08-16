// allow: SIZE_OK -- HEAD 563 -> current ~610 pure LOC; one declarative executer graph with inseparable retry and verdict routing tables plus F1-F4 dual-review prompts.
/**
 * The executer workflow graph: executes a plan produced by the planner workflow
 * (plan Task 3.4, ABG Round 8 decomposition).
 *
 *   admit-plan -> {
 *     plan-admitted          -> parse-plan -> init-notepad -> next-wave -> {
 *                                 wave-pending    -> delegate-wave -> per-task-verify -> checkbox-update -> next-wave (loop)
 *                               | all-tasks-done  -> final-verification-wave -> {
 *                                                       final-approved -> complete
 *                                                     | final-rejected -> fix-loop -> {
 *                                                                          fix-retry   -> next-wave (retry, strikes < budget)
 *                                                                        | fix-blocked -> blocked-escalation (strikes == budget)
 *                                                                        }
 *                                                       }
 *                               }
 *   | plan-rejected-admission -> plan-rejected-terminal (clear failure, no delegation)
 *   }
 *
 * The executer FIRST admits the plan at the entry gate (plan Task 8): a plan must
 * exist, parse, carry the scaffold sections, have at least one todo, list a
 * Final Verification Wave, and be marked approved/ready. A missing, malformed,
 * or unapproved plan routes to `plan-rejected-terminal` and NEVER reaches task
 * delegation. An admitted plan parses its checklist, delegates waves of tasks
 * via `task()` fan-out, verifies each delegation result through a per-task
 * critic, updates plan checkboxes, and loops until all tasks are checked. It
 * then runs a final verification wave with four parallel critics (F1-F4) that
 * each evaluate a distinct aspect (goal, constraints, tests, code quality) and
 * produce APPROVE/REJECT. The parallel node aggregates their verdicts into
 * `final.verdict` (string `"APPROVE"` iff ALL four approve, else `"REJECT"`);
 * completion is an approval gate, not a normal task. If any critic rejects, the
 * fix-loop node reopens the relevant tasks and routes back to `next-wave`, BUT
 * a bounded 3-strike counter caps the retries (plan Task 10): on the third
 * consecutive rejection the executer routes to `blocked-escalation`, records
 * state/evidence, and blocks for user intervention instead of looping forever.
 * Retries reuse each failed task's persisted child session id so the child
 * resumes with full prior context. The graph loop bound (`maxNodeRuns`) is an
 * independent backstop.
 *
 * All routing uses `blackboard.value.equals` on per-node `outputKey`s, mirroring the default
 * workflow's precise, engine-agnostic declarative routing.
 *
 * allow: SIZE_OK — indivisible declarative graph spec. The factory returns one
 * object that `executer-workflow-graph.test.ts` asserts is byte-identical to
 * `examples/abg/executer.workflow.json` via `toEqual`. The admission gate (plan
 * Task 8) adds the admit-plan + plan-rejected-terminal nodes; the deterministic
 * admission helper lives in `executer-plan-admission.ts` to keep this factory a
 * single data table.
 */
import type { AbgGraphSpec, AbgNodeModelOptions } from '@mission-control/protocol';
import { DELEGATE_WORKER_YIELD_RETRY_GUIDANCE } from './delegate-worker-yield-retry';

export const EXECUTER_WORKFLOW_GRAPH_ID = 'executer';
export const EXECUTER_WORKFLOW_MAX_NODE_RUNS = 64;

/**
 * Admission-gate prompt (plan Task 8). Instructs the model to verify the plan
 * is complete and approved BEFORE any delegation, writing `plan.admitted=true`
 * or `plan.admitted=false`. The deterministic contract lives in
 * `evaluatePlanAdmission` (`executer-plan-admission.ts`); this prompt mirrors it.
 */
export const EXECUTER_PLAN_ADMISSION_PROMPT =
    'You are the Mission Control executer workflow plan-admission conductor. BEFORE any task ' +
    'delegation, verify the plan is complete and approved. Read the plan from ' +
    '.mc/plans/<slug>.md and check ALL of: ' +
    '(1) the plan exists and is non-empty; (2) it carries the scaffold sections ## TL;DR, ' +
    '## Scope, ## Todos, ## Final Verification Wave; (3) ## Todos contains at least one ' +
    '"- [ ]" checkbox; (4) ## Final Verification Wave is present; (5) the plan is marked ' +
    'approved/ready (a "Status: Approved" | "Status: Ready" | "Status: Accepted" line). ' +
    'A missing, malformed, or unapproved plan must never reach delegate-wave — the graph ' +
    'routes a rejected plan to plan-rejected-terminal which emits a clear failure event ' +
    'and stops.\n' +
    'Output ONLY the JSON boolean `true` if every check passes, or `false` if any check fails — ' +
    'no prose, no formatting, no extra text.';

/** Terminal failure prompt for a plan rejected at admission. */
export const EXECUTER_PLAN_REJECTED_PROMPT =
    'The plan was rejected at admission. Emit a clear, single failure event stating why the ' +
    'plan could not be admitted (missing, malformed, unapproved, or incomplete) and stop. Do ' +
    'NOT attempt delegation, checkbox updates, or fix-loops — the Mission Control executer ' +
    'workflow cannot execute without an admissible plan. Set plan.rejected=true.';

/**
 * Section-scoped plan-parsing prompt (plan Task 9). Instructs the model to
 * count only column-0 checkboxes under `## Todos` / `## TODOs` and `## Final
 * Verification Wave`, ignoring nested and out-of-section checkboxes, and to
 * surface `nextTaskLabel` (the first unchecked todo). Mirrors the deterministic
 * `parsePlanSections` contract in `persistence/plan-store.ts`.
 */
export const EXECUTER_PARSE_PLAN_PROMPT =
    'Read the plan file from .mc/plans/{slug}.md and parse it with section-scoped counting: ' +
    'only column-0 checkboxes (`- [ ]` / `- [x]`) that fall under a `## Todos` / `## TODOs` or ' +
    '`## Final Verification Wave` heading are counted as actionable tasks. Ignore nested or ' +
    'indented checkboxes and ignore checkboxes under any other heading (Notes, Acceptance ' +
    'Criteria, Evidence, Definition of Done, etc.). Store the ordered task list under ' +
    'plan.todos and surface nextTaskLabel = the label of the first unchecked todo so the ' +
    'delegate-wave can name it. Set plan.parsed when complete.';

/**
 * Append-only notepad initialization prompt (plan Task 9). The executer must
 * read `.mc/notepads/{plan}/learnings.md` BEFORE delegation so inherited
 * wisdom flows into every child prompt, and must require delegated tasks to
 * APPEND findings (never overwrite). Mirrors the Mission Control append-only notepad protocol.
 */
export const EXECUTER_INIT_NOTEPAD_PROMPT =
    'As the Mission Control executer workflow conductor, read the append-only notepad at ' +
    '.mc/notepads/{plan}/learnings.md (create it if absent) BEFORE delegation. ' +
    'Extract prior learnings, decisions, and issues to pass as Inherited Wisdom to every ' +
    'delegated task. The notepad is append-only: delegated tasks MUST append findings via ' +
    'appendNotepad / assertAppendOnly — never overwrite or truncate. Set notepad.ready when ' +
    'the notepad is read and the inherited-wisdom block is prepared.';

/**
 * The six mandatory sections of every executer delegation prompt (plan Task 9,
 * mirrors the Mission Control executer 6-section delegation contract). Each delegated
 * task prompt MUST include ALL six sections. Declared as config metadata on
 * the delegate-wave node so tests and graph readers can verify the contract.
 */
export const EXECUTER_DELEGATION_SECTIONS = [
    'TASK',
    'EXPECTED OUTCOME',
    'REQUIRED TOOLS',
    'MUST DO',
    'MUST NOT DO',
    'CONTEXT',
] as const;

/**
 * Delegate-worker system prompt (plan Task 9). Instructs the worker to expect
 * and follow the 6-section delegation prompt structure emitted by the
 * delegate-wave fan-out.
 */
export const EXECUTER_DELEGATE_WORKER_PROMPT =
    'You are a Mission Control executer workflow delegate worker. Execute the delegated ' +
    'sub-task via the task tool. The orchestration prompt you receive MUST contain six ' +
    'sections: ## 1. TASK (exact checkbox item), ## 2. EXPECTED OUTCOME (files, ' +
    'functionality, verification command), ## 3. REQUIRED TOOLS, ## 4. MUST DO, ## 5. MUST NOT ' +
    'DO, ## 6. CONTEXT (notepad paths, inherited wisdom, dependencies). Follow every section. ' +
    'Choose category by work type: investigation/mapping → explore; external/docs-style lookup → ' +
    'librarian (network-enabled); hard reasoning → reasoner or oracle when appropriate; ' +
    'implementation → deep or quick; UI → designer. Prefer category routing with prompt/assignment. ' +
    'This node has no write capability — do not append the notepad yourself. Put notepad paths in ' +
    'CONTEXT and require write-capable children to append findings (never overwrite), or return ' +
    'findings in the yield result for the conductor. ' +
    DELEGATE_WORKER_YIELD_RETRY_GUIDANCE;

/**
 * Verify-before-checkbox prompt (plan Task 9). The checkbox-update node MUST
 * NOT flip a checkbox based only on a child "done" claim. It must independently
 * verify (tests pass, files exist, lsp_diagnostics clean) before flipping, and
 * after flipping it must re-read the plan file to confirm the unchecked count
 * decreased. Mirrors the Mission Control verify-before-checkbox discipline.
 */
export const EXECUTER_CHECKBOX_UPDATE_PROMPT =
    'You are the Mission Control executer workflow checkbox-update conductor. You MUST NOT ' +
    'flip a plan checkbox (`- [ ]` to `- [x]`) based only on a child agent claiming "done". ' +
    'Independently verify each task BEFORE flipping: confirm tests pass (run the plan ' +
    'verification command), confirm the expected files exist and were modified, and confirm ' +
    'lsp_diagnostics is clean on changed files. Only after verification passes, edit ' +
    '.mc/plans/{slug}.md to change the matching `- [ ]` to `- [x]` and write verification ' +
    'evidence. After the edit, READ the plan file again to confirm the unchecked count ' +
    'decreased — this read-back is mandatory. If verification fails, leave the checkbox ' +
    'unchecked and route back to fix-loop. Set checkbox.updated only after the read-back ' +
    'confirms the flip landed.';

/**
 * Hard ceiling on consecutive final-verification-wave failures before the
 * executer stops looping and escalates. Three strikes: the first two rejections
 * reopen tasks and retry (reusing persisted child session ids); the third
 * rejection routes to `blocked-escalation` and blocks for user intervention.
 *
 * This is a TASK-LEVEL retry ceiling, distinct from the per-turn
 * {@linkcode RunawayGuard} request budget. The graph loop bound
 * (`maxNodeRuns`, default 64) is an independent backstop that still protects
 * against infinite loops if the strike counter ever has a bug.
 */
export const EXECUTER_FINAL_STRIKE_BUDGET = 3;

/**
 * Final-verification-wave verdict aggregation contract. The parallel node reads
 * each critic's APPROVE/REJECT output (declared in `verdictSources`) and reduces
 * them with this strategy: APPROVE iff EVERY critic returned APPROVE; any REJECT
 * (or missing/non-APPROVE value) reduces to REJECT. The deterministic source of
 * truth is {@linkcode aggregateFinalVerdict}; the runtime parallel node calls it
 * when `verdictStrategy === 'all-approve'` and writes the result to `verdictKey`.
 */
export const EXECUTER_VERDICT_STRATEGY_ALL_APPROVE = 'all-approve';

/**
 * F1–F4 hybrid dual-review critic prompts. Each lane builds a reviewer
 * assignment for its rubric, calls `task()` once with `category:"reviewer"` or
 * `agent:"reviewer"`, treats child text as claims, and emits whole-output
 * APPROVE|REJECT only (mirrors planner dual-reviewer discipline). Soft prompt
 * bias only — task is not topology-enforced. Capabilities stay `['subagent']`
 * so the pure-structured omit-capabilities gate does not apply.
 */
export const EXECUTER_F1_PROMPT =
    'You are the F1 (goal) final critic for the Mission Control executer workflow. ' +
    'Build a reviewer assignment that checks whether the implementation achieves the plan ' +
    'stated goal (mission outcome, acceptance intent, and delivered scope). Call task() ' +
    'exactly once with category="reviewer" or agent="reviewer" and that assignment. Treat ' +
    'the child text as claims, not proof. After the child returns, output ONLY one ' +
    'whole-output verdict — APPROVE or REJECT — with no prose or formatting. Prefer REJECT ' +
    'when the goal is unmet or evidence is missing.';

export const EXECUTER_F2_PROMPT =
    'You are the F2 (constraints) final critic for the Mission Control executer workflow. ' +
    'Build a reviewer assignment that checks whether every explicit plan constraint was ' +
    'honored (MUST NOT / MUST DO, scope bounds, policy limits, forbidden paths). Call task() ' +
    'exactly once with category="reviewer" or agent="reviewer" and that assignment. Treat ' +
    'the child text as claims, not proof. After the child returns, output ONLY one ' +
    'whole-output verdict — APPROVE or REJECT — with no prose or formatting. Prefer REJECT ' +
    'when any explicit constraint was violated or is unproven.';

export const EXECUTER_F3_PROMPT =
    'You are the F3 (tests-as-claims) final critic for the Mission Control executer workflow. ' +
    'Build a reviewer assignment that verifies test *evidence* already present in the plan, ' +
    'context, and reviewer-child report only: cited commands, logs, assertion names, and ' +
    'pass/fail receipts. Do NOT run the test suite yourself, do NOT invoke bash/command.run, ' +
    'and do NOT claim you executed tests. Call task() exactly once with category="reviewer" ' +
    'or agent="reviewer" and that assignment. Treat the child text as claims, not proof. ' +
    'After the child returns, output ONLY one whole-output verdict — APPROVE or REJECT — ' +
    'with no prose or formatting. Prefer REJECT when cited test evidence is missing, vague, ' +
    'or contradictory.';

export const EXECUTER_F4_PROMPT =
    'You are the F4 (code quality) final critic for the Mission Control executer workflow. ' +
    'Build a reviewer assignment that checks whether the delivered code is clean and ' +
    'well-structured (clarity, cohesion, unnecessary complexity, type-safety, and ' +
    'maintainability relative to the plan). Call task() exactly once with category="reviewer" ' +
    'or agent="reviewer" and that assignment. Treat the child text as claims, not proof. ' +
    'After the child returns, output ONLY one whole-output verdict — APPROVE or REJECT — ' +
    'with no prose or formatting. Prefer REJECT when quality blockers remain.';

/**
 * Fix-loop gate prompt (plan Task 10). The final verification wave REJECTED the
 * implementation. The gate increments a bounded strike counter and routes to
 * either a retry (reopening tasks, reusing persisted child session ids) or to
 * `blocked-escalation` once the 3-strike ceiling is hit. It MUST NOT loop forever.
 */
export const EXECUTER_FIX_LOOP_PROMPT =
    'You are the Mission Control executer workflow fix-loop conductor. The final ' +
    'verification wave REJECTED the implementation (at least one of F1-F4 returned REJECT). ' +
    'Steps: ' +
    '(1) The runtime maintains the strike counter deterministically: before your turn it ' +
    'reads the blackboard key fix.strikes (absent = 0), increments it by one, and writes ' +
    'the new value back — read it, do NOT recompute or rewrite it. ' +
    `(2) After your turn the runtime hard-clamps fix.route via routeFixLoop(newStrikes, ` +
    `budget): a value contradicting the counter is overridden, fail-closed toward ` +
    `"blocked". Choose fix.route honestly from the CURRENT counter: ` +
    `the strike budget is ${EXECUTER_FINAL_STRIKE_BUDGET} (EXECUTER_FINAL_STRIKE_BUDGET). ` +
    '(3) If the strike count is STRICTLY LESS THAN the budget, set fix.route="retry": ' +
    'reopen the rejected plan tasks (uncheck their checkboxes) AND reuse each failed ' +
    "task's persisted child session id from the run taskRetryState / childSessionIds " +
    '(Todo 6 lineage) so the retried child resumes with full prior context instead of ' +
    'starting fresh. (4) If the strike count has reached the budget, set ' +
    'fix.route="blocked" and do NOT loop again. The graph routes fix.route="blocked" to ' +
    'the blocked-escalation node which records state/evidence and blocks for user ' +
    'intervention. Never set fix.route="retry" once the strike budget is exhausted; the ' +
    'graph loop limit (maxNodeRuns) is a backstop but the strike counter is the intended bound.';

/**
 * Blocked-escalation prompt (plan Task 10). The executer exhausted its 3-strike
 * fix budget without all four final critics approving. Terminal-for-now: record
 * state and evidence, then block for human intervention. The executer does not
 * proceed autonomously past this gate.
 */
export const EXECUTER_BLOCKED_ESCALATION_PROMPT =
    'The Mission Control executer workflow exhausted its 3-strike fix budget ' +
    '(fix.strikes reached the ceiling) without all four final critics (F1-F4) approving. ' +
    'Emit a single blocked-escalation event: record the current state (which critics ' +
    'rejected and why, which plan tasks remain open, the last child session ids attempted) ' +
    'and write verifiable evidence to the run record and the evidence directory. Set ' +
    'fix.blocked=true. Do NOT retry, do NOT reopen tasks, do NOT route back to next-wave. ' +
    'Signal for human intervention: the executer workflow cannot proceed autonomously past ' +
    'the final approval gate. A user must review the evidence, fix the root cause, and ' +
    'explicitly resume (clearing the stop marker) before the executer may attempt another ' +
    'fix cycle.';

/**
 * Reduce four critic verdicts into a single final verdict. APPROVE iff every
 * critic returned exactly `'APPROVE'`; any REJECT (or missing/non-APPROVE value)
 * reduces to `'REJECT'` (fail-closed). This is the deterministic contract the
 * `final-verification-wave` parallel node applies when
 * `verdictStrategy === 'all-approve'`.
 *
 * Examples:
 *   aggregateFinalVerdict(['APPROVE','APPROVE','APPROVE','APPROVE']) -> 'APPROVE'
 *   aggregateFinalVerdict(['APPROVE','REJECT','APPROVE','APPROVE']) -> 'REJECT'
 *   aggregateFinalVerdict(['APPROVE', undefined, 'APPROVE', 'APPROVE']) -> 'REJECT'
 */
export function aggregateFinalVerdict(verdicts: ReadonlyArray<string | undefined>): 'APPROVE' | 'REJECT' {
    if (verdicts.length === 0) {
        return 'REJECT';
    }
    for (const verdict of verdicts) {
        if (verdict !== 'APPROVE') {
            return 'REJECT';
        }
    }
    return 'APPROVE';
}

/**
 * Decide the fix-loop route after a final-verification-wave rejection.
 * Returns `'retry'` while the strike count is strictly below the budget, and
 * `'blocked'` once it reaches the ceiling. With the default budget of 3 the
 * first two rejections retry and the third blocks (3-strike ceiling).
 *
 * Examples:
 *   routeFixLoop(1, 3) -> 'retry'
 *   routeFixLoop(2, 3) -> 'retry'
 *   routeFixLoop(3, 3) -> 'blocked'
 */
export function routeFixLoop(strikes: number, budget: number): 'retry' | 'blocked' {
    return strikes >= budget ? 'blocked' : 'retry';
}

export type ExecuterWorkflowGraphOptions = {
    /**
     * Provider/model pin for the graph's `defaults.model`. When omitted, the graph does NOT
     * declare a default model; the runtime resolves each LLM node's model from the session's
     * `modelProviderSelection` (the logged-in provider) at `runContext` time. Pass an explicit
     * model only when a graph should override the session provider.
     */
    readonly model?: AbgNodeModelOptions;
    /** Graph loop bound. Default 64. */
    readonly maxNodeRuns?: number;
};

export function createExecuterWorkflowGraph(options: ExecuterWorkflowGraphOptions = {}): AbgGraphSpec {
    return {
        id: EXECUTER_WORKFLOW_GRAPH_ID,
        version: '0.1.0',
        entryNodeId: 'admit-plan',
        defaults: {
            ...(options.model !== undefined ? { model: options.model } : {}),
            maxNodeRuns: options.maxNodeRuns ?? EXECUTER_WORKFLOW_MAX_NODE_RUNS,
        },
        nodes: [
            {
                id: 'admit-plan',
                kind: 'llm',
                label: 'Plan admission gate — reject missing/malformed/unapproved plans',
                config: {
                    systemPrompt: EXECUTER_PLAN_ADMISSION_PROMPT,
                    outputKey: 'plan.admitted',
                    outputShape: 'boolean',
                },
            },
            {
                id: 'plan-rejected-terminal',
                kind: 'llm',
                label: 'Terminal failure — plan rejected at admission, do not delegate',
                config: {
                    systemPrompt: EXECUTER_PLAN_REJECTED_PROMPT,
                    outputKey: 'plan.rejected',
                },
            },
            {
                id: 'parse-plan',
                kind: 'llm',
                label: 'Parse plan checklist (section-scoped: Todos + Final Verification Wave only)',
                config: {
                    systemPrompt: EXECUTER_PARSE_PLAN_PROMPT,
                    outputKey: 'plan.parsed',
                    parser: 'parsePlanSections',
                    countedSections: ['Todos', 'Final Verification Wave'],
                },
            },
            {
                id: 'init-notepad',
                kind: 'llm',
                label: 'Initialize append-only notepad and extract inherited wisdom',
                config: {
                    systemPrompt: EXECUTER_INIT_NOTEPAD_PROMPT,
                    outputKey: 'notepad.ready',
                    notepadPath: '.mc/notepads/{plan}/learnings.md',
                    notepadMode: 'append-only',
                },
            },
            {
                id: 'next-wave',
                kind: 'llm',
                label: 'Select next wave of unchecked tasks (parallel-by-default, dependency-blocked)',
                config: {
                    systemPrompt:
                        'As the Mission Control executer workflow wave conductor, inspect the ' +
                        'section-scoped plan checklist (plan.todos). If unchecked tasks remain, ' +
                        'output ONLY the JSON boolean `true`. If all tasks are checked, output ' +
                        'ONLY the JSON boolean `false` — no prose, no formatting, no extra text.',
                    outputKey: 'wave.pending',
                    outputShape: 'boolean',
                },
            },
            {
                id: 'delegate-wave',
                kind: 'parallel',
                label: 'Fan out task() delegation per wave task (6-section prompts, parallel-by-default)',
                children: ['delegate-worker'],
                config: {
                    fanOutKey: 'wave.tasks',
                    completionKey: 'delegate.complete',
                    continueOnFailure: true,
                    parallelByDefault: true,
                    dependencyKey: 'plan.dependencies',
                    delegationSections: [...EXECUTER_DELEGATION_SECTIONS],
                },
            },
            {
                id: 'delegate-worker',
                kind: 'llm',
                label: 'Single task() delegation — 6-section prompt contract',
                capabilities: ['subagent'],
                config: {
                    systemPrompt: EXECUTER_DELEGATE_WORKER_PROMPT,
                },
            },
            {
                id: 'per-task-verify',
                kind: 'llm',
                implementation: 'critic',
                label: 'Critic — verify each delegated task result before checkbox update',
                config: {
                    evaluateKey: 'delegate.results',
                    outputKey: 'verify.complete',
                    verifyBeforeCheckbox: true,
                },
            },
            {
                id: 'checkbox-update',
                kind: 'llm',
                label: 'Update plan checkboxes only after independent verification passes',
                config: {
                    systemPrompt: EXECUTER_CHECKBOX_UPDATE_PROMPT,
                    outputKey: 'checkbox.updated',
                    planPath: '.mc/plans/{slug}.md',
                    verifyBeforeCheckbox: true,
                    readBackAfterUpdate: true,
                },
            },
            {
                id: 'final-verification-wave',
                kind: 'parallel',
                label: 'Final verification wave — F1-F4 parallel critics aggregated into final.verdict',
                children: ['f1', 'f2', 'f3', 'f4'],
                config: {
                    completionKey: 'final.complete',
                    verdictKey: 'final.verdict',
                    verdictStrategy: EXECUTER_VERDICT_STRATEGY_ALL_APPROVE,
                    verdictSources: ['final.f1', 'final.f2', 'final.f3', 'final.f4'],
                    aggregateKey: 'final.critics',
                },
            },
            {
                id: 'f1',
                kind: 'llm',
                label: 'F1 — Goal verification critic (dual-review hybrid via task reviewer)',
                capabilities: ['subagent'],
                config: {
                    systemPrompt: EXECUTER_F1_PROMPT,
                    outputKey: 'final.f1',
                    outputEnum: ['APPROVE', 'REJECT'],
                },
            },
            {
                id: 'f2',
                kind: 'llm',
                label: 'F2 — Constraint verification critic (dual-review hybrid via task reviewer)',
                capabilities: ['subagent'],
                config: {
                    systemPrompt: EXECUTER_F2_PROMPT,
                    outputKey: 'final.f2',
                    outputEnum: ['APPROVE', 'REJECT'],
                },
            },
            {
                id: 'f3',
                kind: 'llm',
                label: 'F3 — Test-evidence verification critic (dual-review hybrid via task reviewer)',
                capabilities: ['subagent'],
                config: {
                    systemPrompt: EXECUTER_F3_PROMPT,
                    outputKey: 'final.f3',
                    outputEnum: ['APPROVE', 'REJECT'],
                },
            },
            {
                id: 'f4',
                kind: 'llm',
                label: 'F4 — Code quality verification critic (dual-review hybrid via task reviewer)',
                capabilities: ['subagent'],
                config: {
                    systemPrompt: EXECUTER_F4_PROMPT,
                    outputKey: 'final.f4',
                    outputEnum: ['APPROVE', 'REJECT'],
                },
            },
            {
                id: 'complete',
                kind: 'llm',
                label: 'All verification passed — emit final report',
                capabilities: [],
            },
            {
                id: 'fix-loop',
                kind: 'llm',
                label: 'Final verification rejected — bounded 3-strike fix loop',
                config: {
                    systemPrompt: EXECUTER_FIX_LOOP_PROMPT,
                    outputKey: 'fix.route',
                    // Equals-routed enum gate: applyEnumConstraint fails closed on any non-{retry,blocked} value, preventing a poisoned fix.route from silently completing or skipping blocked-escalation.
                    outputEnum: ['retry', 'blocked'],
                    strikeKey: 'fix.strikes',
                    strikeBudget: EXECUTER_FINAL_STRIKE_BUDGET,
                    maxStrikes: EXECUTER_FINAL_STRIKE_BUDGET,
                    lineageKey: 'run.childSessionIds',
                    retryStateKey: 'run.taskRetryState',
                },
            },
            {
                id: 'blocked-escalation',
                kind: 'llm',
                label: 'Strike budget exhausted — record state/evidence and block for user',
                config: {
                    systemPrompt: EXECUTER_BLOCKED_ESCALATION_PROMPT,
                    outputKey: 'fix.blocked',
                    evidencePath: '.mc/evidence/',
                    strikeBudget: EXECUTER_FINAL_STRIKE_BUDGET,
                },
            },
        ],
        edges: [
            { source: 'admit-plan', target: 'parse-plan', condition: 'plan-admitted', priority: 20 },
            {
                source: 'admit-plan',
                target: 'plan-rejected-terminal',
                condition: 'plan-rejected-admission',
                priority: 10,
            },
            { source: 'parse-plan', target: 'init-notepad', condition: 'plan-parsed', priority: 10 },
            { source: 'init-notepad', target: 'next-wave', condition: 'notepad-ready', priority: 10 },
            { source: 'next-wave', target: 'delegate-wave', condition: 'wave-pending', priority: 20 },
            { source: 'next-wave', target: 'final-verification-wave', condition: 'all-tasks-done', priority: 10 },
            { source: 'delegate-wave', target: 'per-task-verify', condition: 'delegate-complete', priority: 10 },
            { source: 'per-task-verify', target: 'checkbox-update', condition: 'verify-done', priority: 10 },
            { source: 'checkbox-update', target: 'next-wave', condition: 'checkbox-updated', priority: 10 },
            { source: 'final-verification-wave', target: 'complete', condition: 'final-approved', priority: 20 },
            { source: 'final-verification-wave', target: 'fix-loop', condition: 'final-rejected', priority: 10 },
            { source: 'fix-loop', target: 'next-wave', condition: 'fix-retry', priority: 20 },
            { source: 'fix-loop', target: 'blocked-escalation', condition: 'fix-blocked', priority: 10 },
            { source: 'admit-plan', target: 'admit-plan', condition: 'llm-loop-active', priority: 5 },
            { source: 'parse-plan', target: 'parse-plan', condition: 'llm-loop-active', priority: 5 },
            { source: 'init-notepad', target: 'init-notepad', condition: 'llm-loop-active', priority: 5 },
            { source: 'next-wave', target: 'next-wave', condition: 'llm-loop-active', priority: 5 },
            { source: 'delegate-worker', target: 'delegate-worker', condition: 'llm-loop-active', priority: 5 },
            { source: 'per-task-verify', target: 'per-task-verify', condition: 'llm-loop-active', priority: 5 },
            { source: 'checkbox-update', target: 'checkbox-update', condition: 'llm-loop-active', priority: 5 },
            { source: 'f1', target: 'f1', condition: 'llm-loop-active', priority: 5 },
            { source: 'f2', target: 'f2', condition: 'llm-loop-active', priority: 5 },
            { source: 'f3', target: 'f3', condition: 'llm-loop-active', priority: 5 },
            { source: 'f4', target: 'f4', condition: 'llm-loop-active', priority: 5 },
            { source: 'fix-loop', target: 'fix-loop', condition: 'llm-loop-active', priority: 5 },
        ],
        rules: [
            {
                id: 'llm-loop-active',
                description: 'LLM node re-enters while it proposes tool calls',
                when: { kind: 'blackboard.value.equals', key: 'llm.loop_active', value: true },
            },
            {
                id: 'plan-admitted',
                description: 'plan passed admission — parse and execute',
                when: { kind: 'blackboard.value.equals', key: 'plan.admitted', value: true },
            },
            {
                id: 'plan-rejected-admission',
                description: 'plan failed admission — terminate, do not delegate',
                when: { kind: 'blackboard.value.equals', key: 'plan.admitted', value: false },
            },
            {
                id: 'plan-parsed',
                description: 'plan parsed successfully',
                when: { kind: 'blackboard.key.exists', key: 'plan.parsed' },
            },
            {
                id: 'notepad-ready',
                description: 'notepad initialized',
                when: { kind: 'blackboard.key.exists', key: 'notepad.ready' },
            },
            {
                id: 'wave-pending',
                description: 'unchecked tasks remain in the plan',
                when: { kind: 'blackboard.value.equals', key: 'wave.pending', value: true },
            },
            {
                id: 'all-tasks-done',
                description: 'all plan tasks checked',
                when: { kind: 'blackboard.value.equals', key: 'wave.pending', value: false },
            },
            {
                id: 'delegate-complete',
                description: 'delegation wave finished',
                when: { kind: 'blackboard.value.equals', key: 'delegate.complete', value: true },
            },
            {
                id: 'verify-done',
                description: 'per-task verification complete',
                when: { kind: 'blackboard.key.exists', key: 'verify.complete' },
            },
            {
                id: 'checkbox-updated',
                description: 'plan checkboxes updated',
                when: { kind: 'blackboard.key.exists', key: 'checkbox.updated' },
            },
            {
                id: 'final-approved',
                description: 'all final critics approved',
                when: { kind: 'blackboard.value.equals', key: 'final.verdict', value: 'APPROVE' },
            },
            {
                id: 'final-rejected',
                description: 'at least one final critic rejected',
                when: { kind: 'blackboard.value.equals', key: 'final.verdict', value: 'REJECT' },
            },
            {
                id: 'fix-retry',
                description: 'fix-loop reopening tasks (strike count under the 3-strike ceiling)',
                when: { kind: 'blackboard.value.equals', key: 'fix.route', value: 'retry' },
            },
            {
                id: 'fix-blocked',
                description: 'fix-loop strike budget exhausted — escalate, do not loop',
                when: { kind: 'blackboard.value.equals', key: 'fix.route', value: 'blocked' },
            },
        ],
        policies: [],
    };
}
