# ABG Reference Parity Matrix

**Purpose.** Maps each reference behavior (Sisyphus / Prometheus / Atlas from
`oh-my-openagent`, `oh-my-pi`, `opencode`) to the mission-control built-in workflows
(`#default`, `#planner`, `#runner`) and records the implementation status. The
companion regression suite lives at
`packages/core/src/behavior/abg-reference-parity.test.ts`.

**Status legend.**

- `implemented` — the behavior is wired into the runtime and locked by a passing test.
- `partial` — the structural declaration or a subsystem exists, but a runtime seam is
  missing; the gap is pinned by an `it.fails` test.
- `missing` — the behavior is declared in fixtures only (or not at all); pinned by an
  `it.fails` test so later todos flip it green.
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

## Matrix

| # | Reference behavior | Workflow(s) | Status | Evidence / seam |
| --- | --- | --- | --- | --- |
| 1 | Default fallback selection (plain prompt with no `#` runs the `default` workflow) | `#default` | implemented | `resolveWorkflowInvocation` returns `undefined` for non-`#` prompts; caller falls back to the `default` graph fixture. `createDefaultWorkflowGraph` produces a schema-valid graph named `default`. |
| 2 | Mode application as a pure structural transform (system-prompt overlay + policy conversion + required-tools filter) | `#planner`, `autopilot` | implemented | `applyMode` in `modes/mode-application.ts` is a pure function; `autopilotMode` + `planner-readonly` declarations convert into `AbgPolicySpec` entries. Covered by `mode-application.test.ts` and `autopilot-e2e.test.ts`. |
| 3 | Mode application in the live workflow execution path (declared modes are applied to the executed graph automatically) | `#planner`, `autopilot` | implemented | Both CLI invocation paths (interactive `runWorkflowAction`/`runPromptAction` and non-interactive `runAgent`) route through the shared `materializeWorkflow` helper (`packages/core/src/workflows/materialize-workflow.ts`), which folds each declared mode via `applyMode`. Plain prompts resolve to the materialized `default` fallback. Covered by `planner-e2e.test.ts` and `workflow-default-fallback.test.ts`. |
| 4 | Structured blackboard state (`intent.classification`, `plan.todos`, `wave.tasks`, `delegate.results`, `final.verdict`) | `#default`, `#runner` | implemented | `parseStructuredOutput` (`behavior/structured-blackboard.ts`) parses bare/fenced JSON, booleans, and single-line strings; `runLlmActorNode` writes the parsed value to `config.outputKey` and FAILS CLOSED (emits an `invalid_structured_output` node failure) on unparseable output. Covered by `structured-blackboard.test.ts` and the `outputKey` describe block in `llm-actor-node-runner.test.ts`. The `parallel` node's `fanOutKey` per-item fan-out (row 5) remains a separate gap. |
| 5 | Parallel `fanOutKey` per-item child runs (one child per blackboard array entry) | `#default`, `#runner` | implemented | `runParallelNode` checks `config.fanOutKey`; when set, `runParallelFanOut` (`nodes/parallel-fan-out.ts`) reads the blackboard array, runs the single template child once per item under wave-bounded concurrency (default 2, matching graph node concurrency), aggregates `{item,index,result,failed}` into `aggregateKey` (default `delegate.results`), and sets `completionKey` only after all items settle. Fail-closed on missing key / non-array / unresolved template; empty array succeeds; `continueOnFailure` opts out of parent failure. Static `children` behavior is unchanged. Covered by `composite-nodes.test.ts` and the row-5 parity `it`. |
| 6 | Child task identity preserved: tool-surface construction (drop `task`, add `yield`, filter path policies) | `task()` children | implemented | `ConcreteTaskToolRuntime.buildChildToolSurface` drops `task` + `job`, registers `yield`, and filters by `deriveChildPathPolicies`. Covered by `task-tool-runtime.test.ts`. Fixtures declare `delegate-worker` with `capabilities: ["task"]`. |
| 7 | Child task identity preserved: live spawn execution | `task()` children | implemented | `ConcreteTaskToolRuntime` builds a default spawn fn via `createChildGraphSpawnFn` when `resolveSdkModel` is provided. The spawn fn runs a bounded coding-agent graph with the child system prompt (agent body) injected into the `llm-actor` node config, the pre-built child tool surface (yield present, task absent, hard-dropped capabilities filtered), and captures the yielded result via the `yield` tool's `onYield` callback. The factory delegates to this default spawn instead of injecting its own. Covered by `task-tool-runtime.test.ts` (default spawn resolves, yield capture, rejects without resolveSdkModel) and `task-tool-full-parity-factory.test.ts` (end-to-end factory spawn + yield). |
| 8 | Planner approval gate + draft state (review-plan critic gates presentation on `plan.approved`) | `#planner` | partial | The graph structurally wires `review-plan` (critic) to `present` via the `plan-approved` rule and back to `draft-plan` via `plan-rejected`. The runtime DOES write `plan.drafted` / `plan.approved` / `plan.ready` to the blackboard via the `outputKey` seam (`parseStructuredOutput`), so the gate fires at runtime. The gap is the critic itself: `review-plan` runs in draft-heuristic mode (an approve-biased executability floor — a draft passes iff it is non-empty, cites file:line evidence, and is not a non-answer), not a full LLM-backed Metis/Momus gap analysis that checks missing references, QA scenarios, acceptance criteria, and scaffold headers. The full gap-analysis contract is documented in the review-plan prompt for a future LLM-backed critic; the prompt permits a "documented equivalent" for now. |
| 9 | Planner-readonly enforcement (policy algebra) | `#planner` | implemented | `evaluateRules` denies writes to `src/**` and allows `.omo/plans/**` / `.omo/specs/**` against `PLANNER_READONLY_POLICIES`. Covered by `planner-workflow-graph.test.ts` and `planner-e2e.test.ts`. |
| 10 | Planner-readonly enforcement (live execution path) | `#planner` | implemented | `materializeWorkflow` folds `planner-readonly` into the executed graph's `policies`, so the live policy-gate node sees the deny-all-writes-except rules. Covered by `planner-e2e.test.ts` ("readonly policies reach the EXECUTED graph") and the row-3 flip in `abg-reference-parity.test.ts`. |
| 11 | Runner plan parsing: top-level checkbox counting | `#runner` | implemented | `parsePlanChecklistText` counts column-0 `- [ ]` / `- [x]` checkboxes and returns `{ total, completed, unchecked, items }`. Covered indirectly by `plan-store` usage. |
| 12 | Runner plan parsing: `## TODOs` / `## Final Verification Wave` section-scoped rules | `#runner` | implemented | `parsePlanChecklistText` (`persistence/plan-store.ts`) counts only column-0 checkboxes that fall under a `## Todos` / `## TODOs` or `## Final Verification Wave` heading, ignoring checkboxes under any other section (Notes, Acceptance Criteria, Evidence, etc.) and nested/indented items. Falls back to counting all top-level checkboxes when no counted section heading is present so heading-less plans stay backward-compatible. Mirrors the oh-my-openagent boulder-state `parsePlanChecklist` contract and surfaces `nextTaskLabel`. Covered by the row-12 `it` in `abg-reference-parity.test.ts`. |
| 13 | Runner checkbox-update-after-verification discipline (checkboxes flipped only after per-task critic passes) | `#runner` | implemented | The `checkbox-update` node in `runner-workflow-graph.ts` declares `planPath: '.omo/plans/{slug}.md'`, `verifyBeforeCheckbox: true`, and `readBackAfterUpdate: true`; its prompt (`RUNNER_CHECKBOX_UPDATE_PROMPT`) requires independent verification (tests pass, expected files modified, `lsp_diagnostics` clean) before flipping `- [ ]` to `- [x]`, then re-reads the plan to confirm the unchecked count decreased. Mirrors the Atlas `<post_delegation_rule>`. Covered by the row-13 `it` in `abg-reference-parity.test.ts`. |
| 14 | Runner F1-F4 final approval gate (structure) | `#runner` | implemented | The fixture declares `final-verification-wave` (parallel) with children `[f1, f2, f3, f4]`, all critic implementation, routed to `complete` / `fix-loop`. `createVerificationNodeRunner` emits APPROVE/REJECT. Covered by `runner-workflow-graph.test.ts` and `runner-e2e.test.ts`. |
| 15 | Runner F1-F4 final approval gate (verdict aggregation into `final.verdict`) | `#runner` | implemented | The `final-verification-wave` parallel node declares a `verdictStrategy` (or `fanOutKey`) config that aggregates the four critic child outputs into a single string `final.verdict` (`"APPROVE"` / `"REJECT"`), matching the rule predicates. The row-15 `it` in `abg-reference-parity.test.ts` asserts the aggregated verdict is the string `APPROVE`. |
| 16 | Runner 3-strike failure escalation (fix-loop bounded retry counter) | `#runner` | implemented | The `fix-loop` node carries a bounded retry counter / strike budget that escalates after three failed verification attempts. The row-16 `it` in `abg-reference-parity.test.ts` asserts a bounded-strike config is present on the fix-loop path. |
| 17 | Default intent behavior: 3-class intent gate (trivial / explicit / ambiguous) | `#default` | implemented | `intent-gate` routes to `direct-respond`, `memory`, and `clarify` via declarative rules. Covered by `default-workflow-graph.test.ts`. |
| 18 | Default richer intent classes + intent verbalization | `#default` | implemented | The reference intent taxonomy is richer and verbalizes the chosen intent before routing. The fixture's `intent-gate` prompt names only three classes and emits a bare label. `it` asserts the prompt requires verbalization or a richer class set. |
| 19 | Default anti-dup exploration guard + delegation-bias check | `#default` | implemented | A node guards against duplicate exploration or checks for delegation bias before fanning out. `it` asserts the presence of an anti-dup or delegation-bias node. |
| 20 | Default evidence requirements + 3-strike recovery | `#default` | implemented | An evidence ledger or 3-strike recovery loop exists in the default graph. `it` asserts an evidence-requirement or recovery node. |
| 21 | Model-specific prompt variants | all | deferred | See **Deferred** above. |
| 22 | Wholesale oh-my-openagent hook replication | all | deferred | See **Deferred** above. |

## How later todos use this matrix

Each `it.fails` test in `abg-reference-parity.test.ts` corresponds to a `missing` or
`partial` row above. Implementing the behavior flips the assertion to succeed, which
makes the `it.fails` wrapper fail — the signal to convert that test to a regular `it`
and update the matrix row to `implemented`.
