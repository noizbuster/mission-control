# ABG Reference Parity Matrix

**Purpose.** Maps each reference behavior (Sisyphus / Prometheus / Atlas from
`oh-my-openagent`, `oh-my-pi`, `opencode`) to the mission-control built-in workflows
(`#default`, `#planner`, `#runner`) and records the implementation status. The
companion regression suite lives at
`packages/core/src/behavior/abg-reference-parity.test.ts`.

**Status legend.**

- `implemented` — the behavior is wired into the runtime and locked by a passing test.
- `partial` — the structural declaration or a subsystem exists, but a documented
  runtime or fidelity gap remains.
- `missing` — the behavior is declared in fixtures only (or not at all).
- `deferred` — intentionally out of scope for this alignment pass.

**Deferred (explicit).**

- **Model-specific prompt variants.** Reference harnesses ship per-model persona
  variants; mission-control intentionally keeps personas model-agnostic and routes
  reasoning effort through the `provider/model#variant` syntax instead. Replicating
  per-model prompt variants is deferred.
- **Wholesale oh-my-openagent hook replication.** The reference hook surface (pre/post
  turn, tool, session hooks) is not ported wholesale. Mission-control reaches parity
  through its own ABG graph + policy-gate + mode-overlay mechanisms instead of a hook
  bus. Hook-by-hook replication is deferred.
- **Intent verbalization.** The reference gate explains its intent before routing;
  mission-control uses a strict single-line classification output so prose cannot be
  mistaken for structured state. Rich five-class routing is implemented, but
  verbalized output is deferred.

## Matrix

| # | Reference behavior | Workflow(s) | Status | Evidence / seam |
| --- | --- | --- | --- | --- |
| 1 | Default fallback selection (plain prompt with no `#` runs the `default` workflow) | `#default` | implemented | `resolveWorkflowInvocation` returns `undefined` for non-`#` prompts; caller falls back to the `default` graph fixture. `createDefaultWorkflowGraph` produces a schema-valid graph named `default`. |
| 2 | Mode application as a pure structural transform (system-prompt overlay + policy conversion + required-tools filter) | `#planner`, `autopilot` | implemented | `applyMode` in `modes/mode-application.ts` is a pure function; `autopilotMode` + `planner-readonly` declarations convert into `AbgPolicySpec` entries. Covered by `mode-application.test.ts` and `autopilot-e2e.test.ts`. |
| 3 | Mode application in the live workflow execution path (declared modes are applied to the executed graph automatically) | `#planner`, `autopilot` | implemented | Both CLI invocation paths (interactive `runWorkflowAction`/`runPromptAction` and non-interactive `runAgent`) route through the shared `materializeWorkflow` helper (`packages/core/src/workflows/materialize-workflow.ts`), which folds each declared mode via `applyMode`. Plain prompts resolve to the materialized `default` fallback. Covered by `planner-e2e.test.ts` and `workflow-default-fallback.test.ts`. |
| 4 | Structured blackboard state (`intent.classification`, `plan.todos`, `wave.tasks`, `delegate.results`, `final.verdict`) | `#default`, `#runner` | implemented | `parseStructuredOutput` (`behavior/structured-blackboard.ts`) parses only a whole bare JSON value, whole-output ```json or untagged fence, exact boolean, or single-line string; shape validation rejects null/primitives as objects. `runLlmActorNode` writes the parsed value to `config.outputKey` and FAILS CLOSED (emits an `invalid_structured_output` node failure) on unparseable output, with no trailing-line, guessed, or defaulted fallback. Covered by `structured-blackboard.test.ts` and the `outputKey` describe block in `llm-actor-node-runner.test.ts`. The `parallel` node's `fanOutKey` per-item fan-out (row 5) remains a separate seam. |
| 5 | Parallel `fanOutKey` per-item child runs (one child per blackboard array entry) | `#default`, `#runner` | implemented | `runParallelNode` checks `config.fanOutKey`; when set, `runParallelFanOut` (`nodes/parallel-fan-out.ts`) reads the blackboard array, runs the single template child once per item under wave-bounded concurrency (default 2, matching graph node concurrency), aggregates `{item,index,result,failed}` into `aggregateKey` (default `delegate.results`), and sets `completionKey` only after all items settle. Fail-closed on missing key / non-array / unresolved template; empty array succeeds; `continueOnFailure` opts out of parent failure. Static `children` use a distinct bounded implementation. Covered by `parallel-fan-out.test.ts`, `static-parallel.test.ts`, and the row-5 parity `it`. |
| 6 | Child task identity preserved: tool-surface construction (drop `task`, add `yield`, filter path policies) | `task()` children | implemented | Standalone `buildChildToolSurface` in `agents/task-tool-runtime-authority.ts` intersects category and agent tool allowlists, drops `task` + `job`, hard-drops `subagent`/`workflow`/`network`/`team`, registers `yield`, and installs category plus `deriveChildPathPolicies` invocation checks. Retained effectful tools keep workspace permission callbacks; destructive tools are policy-controlled. Covered by `task-tool-runtime*.test.ts`. Fixtures declare `delegate-worker` with `capabilities: ["subagent"]`. |
| 7 | Child task identity preserved: live spawn execution | `task()` children | implemented | `ConcreteTaskToolRuntime` builds a default spawn fn via `createChildGraphSpawnFn` when `resolveSdkModel` is provided. The spawn fn runs a bounded coding-agent graph with the child system prompt (agent body) injected into the `llm-actor` node config, the pre-built child tool surface (yield present, task absent, hard-dropped capabilities filtered), and captures the yielded result via the `yield` tool's `onYield` callback. A missing yield produces a failed, bounded degraded salvage summary. Child resumes recompute and compare an authority fingerprint over the effective authority, rejecting a changed surface, policy, definition, model, or prompt. The factory delegates to this default spawn instead of injecting its own. Covered by `task-tool-runtime.test.ts` (default spawn resolves, yield capture, rejects without resolveSdkModel), `task-tool-full-parity-factory.test.ts` (end-to-end factory spawn + yield), and `task-tool-runtime-authority.test.ts` (resume authority). |
| 8 | Planner approval gate + draft state (review-plan critic gates approval on `critic.passed`) | `#planner` | partial | The graph structurally wires `review-plan` (critic) to `approval-gate` via the `plan-approved` rule and back to `draft-plan` via `plan-rejected`; both rules evaluate `critic.passed`. The generic LLM `outputKey` seam persists `plan.drafted` and `plan.ready`, while the deterministic critic writes `critic.passed` directly; its declared `plan.approved` output key is not the routing authority. The remaining gap is the critic itself: `review-plan` runs in draft-heuristic mode (an approve-biased executability floor — a draft passes iff it is non-empty, cites file:line evidence, and is not a non-answer), not a full LLM-backed Metis/Momus gap analysis that checks missing references, QA scenarios, acceptance criteria, and scaffold headers. The full gap-analysis contract is documented in the review-plan prompt for a future LLM-backed critic; the prompt permits a "documented equivalent" for now. |
| 9 | Planner-readonly enforcement (policy algebra) | `#planner` | implemented | `evaluateRules` denies writes to `src/**` and allows `.omo/plans/**` / `.omo/specs/**` against `PLANNER_READONLY_POLICIES`. Covered by `planner-workflow-graph.test.ts` and `planner-e2e.test.ts`. |
| 10 | Planner-readonly enforcement (live execution path) | `#planner` | implemented | `materializeWorkflow` folds `planner-readonly` into the executed graph's `policies`, so the live policy-gate node sees the deny-all-writes-except rules. Covered by `planner-e2e.test.ts` ("readonly policies reach the EXECUTED graph") and the row-3 flip in `abg-reference-parity.test.ts`. |
| 11 | Runner plan parsing: top-level checkbox counting | `#runner` | implemented | `parsePlanChecklistText` counts column-0 `- [ ]` / `- [x]` checkboxes and returns `{ total, completed, unchecked, items }`. Covered indirectly by `plan-store` usage. |
| 12 | Runner plan parsing: `## TODOs` / `## Final Verification Wave` section-scoped rules | `#runner` | implemented | `parsePlanChecklistText` (`persistence/plan-store.ts`) counts only column-0 checkboxes that fall under a `## Todos` / `## TODOs` or `## Final Verification Wave` heading, ignoring checkboxes under any other section (Notes, Acceptance Criteria, Evidence, etc.) and nested/indented items. Falls back to counting all top-level checkboxes when no counted section heading is present so heading-less plans stay backward-compatible. Mirrors the oh-my-openagent boulder-state `parsePlanChecklist` contract and surfaces `nextTaskLabel`. Covered by the row-12 `it` in `abg-reference-parity.test.ts`. |
| 13 | Runner checkbox-update-after-verification discipline (checkboxes flipped only after per-task critic passes) | `#runner` | implemented | The `checkbox-update` node in `runner-workflow-graph.ts` declares `planPath: '.omo/plans/{slug}.md'`, `verifyBeforeCheckbox: true`, and `readBackAfterUpdate: true`; its prompt (`RUNNER_CHECKBOX_UPDATE_PROMPT`) requires independent verification (tests pass, expected files modified, `lsp_diagnostics` clean) before flipping `- [ ]` to `- [x]`, then re-reads the plan to confirm the unchecked count decreased. Mirrors the Atlas `<post_delegation_rule>`. Covered by the row-13 `it` in `abg-reference-parity.test.ts`. |
| 14 | Runner F1-F4 final approval gate (structure) | `#runner` | implemented | The fixture declares `final-verification-wave` (parallel) with children `[f1, f2, f3, f4]`, all critic implementation, routed to `complete` / `fix-loop`. `createVerificationNodeRunner` emits APPROVE/REJECT. Covered by `runner-workflow-graph.test.ts` and `runner-e2e.test.ts`. |
| 15 | Runner F1-F4 final approval gate (verdict aggregation into `final.verdict`) | `#runner` | implemented | The `final-verification-wave` parallel node declares a `verdictStrategy` (or `fanOutKey`) config that aggregates the four critic child outputs into a single string `final.verdict` (`"APPROVE"` / `"REJECT"`), matching the rule predicates. The row-15 `it` in `abg-reference-parity.test.ts` asserts the aggregated verdict is the string `APPROVE`. |
| 16 | Runner 3-strike failure escalation (fix-loop bounded retry counter) | `#runner` | implemented | The `fix-loop` node carries a bounded retry counter / strike budget that escalates after three failed verification attempts. The row-16 `it` in `abg-reference-parity.test.ts` asserts a bounded-strike config is present on the fix-loop path. |
| 17 | Default intent behavior: strict five-class gate | `#default` | implemented | `intent-gate` requires exactly `trivial`, `exploratory-research`, `open-ended-planning`, `explicit-implementation`, or `ambiguous`, then routes through declarative rules. Covered by `default-workflow-graph.test.ts`. |
| 18 | Intent verbalization | `#default` | deferred | The gate emits no prose explanation before routing. It requires one strict class output because multiline or reasoning text is rejected by the structured parser. |
| 19 | Default anti-dup exploration guard + delegation-bias check | `#default` | implemented | A node guards against duplicate exploration or checks for delegation bias before fanning out. `it` asserts the presence of an anti-dup or delegation-bias node. |
| 20 | Default evidence requirements + 3-strike recovery | `#default` | implemented | An evidence ledger or 3-strike recovery loop exists in the default graph. `it` asserts an evidence-requirement or recovery node. |
| 21 | Model-specific prompt variants | all | deferred | See **Deferred** above. |
| 22 | Wholesale oh-my-openagent hook replication | all | deferred | See **Deferred** above. |

## Bounded Composite Contracts

- **Static `parallel`.** Without `config.fanOutKey`, declared `children` run in waves. A positive integer `config.concurrency` selects the local bound, defaulting to 2. Signals and results aggregate in declaration order. A rejected child iterator becomes a failure, so normal all-child completion fails closed.
- **`fanOutKey` parallel.** This separate path reads a blackboard array and invokes one template child per item. Its array aggregation contract is row 5.
- **`race`.** At most 4 declared children start, and excess authoring fails before any branch starts. The winner is the earliest valid completion observed in the current process. Cooperative branches drain through `.return()` during cleanup (5000ms default; positive integer `cleanupTimeoutMs` capped at 30000ms). Cleanup timeout, return rejection, or `next()`/pump rejection fails the Race even after a valid winner; an ordinary child failure signal may lose without poisoning that winner. Arbitrary work is not forcibly terminated. Durable committed-order arbitration is deferred. Focused coverage lives in `nodes/race-node-authoring.test.ts`, `nodes/race-node-basic.test.ts`, and `nodes/race-node.test.ts`.
- **Custom workflow migration.** For an `llm` node with `outputKey`, prompt for one whole, exact representation. Do not rely on reasoning followed by a final line because the runtime does not extract it or supply a default.

## Expected-failure status

`abg-reference-parity.test.ts` has no expected-failure tests. Row 8 remains
`partial` only because the review critic is an approve-biased deterministic
executability floor rather than a full LLM-backed Metis/Momus gap analysis.
Implemented `plan.drafted` / `plan.ready` persistence and `critic.passed` routing
are covered by normal passing tests.
