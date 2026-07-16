# ABG Reference Parity Matrix

**Purpose.** Maps ABG-aligned built-in workflows to their roles:

| Workflow | Role |
| --- | --- |
| `#default` | Plan-first plain-prompt fallback |
| `#planner` | Deep autonomous planning craft |
| `#executer` | Plan execution conductor |
| `#fixer` | Intent-gated implement/fix |

Companion suite: `packages/core/src/behavior/abg-reference-parity.test.ts`.

**Status legend.** `implemented` / `partial` / `deferred`.

## Matrix

| # | Behavior | Workflow(s) | Status |
| --- | --- | --- | --- |
| 1 | Plain prompt (no `#`) runs `default` | `#default` | implemented |
| 2–3 | Mode application (pure + live) | `#default`, `#planner`, autopilot | implemented |
| 4 | Structured blackboard fail-closed | all | implemented |
| 5 | Parallel `fanOutKey` fan-out | `#executer`, `#fixer` | implemented |
| 6–7 | Child task identity | `task()` children | implemented |
| 8 | Plan review critic + planner craft (floor, metis, dual-review, interview, resume-gate) | `#default`, `#planner` | implemented |
| 9–10 | Plan-readonly policies | `#default`, `#planner` | implemented |
| 11–16 | Plan parse, checkbox, F1–F4, 3-strike | `#executer` | implemented |
| 17–20 | Intent gate, anti-dup, evidence | `#fixer` | implemented (verbalization deferred) |

## Row 8 detail (`#planner` craft)

Shared with `#default`:

- Deterministic `review-plan` critic floor routes on `critic.passed` (approve-biased floor).
- Draft → review → approval → write-plan handoff; `plan.ready` gates the final write.

`#planner`-only (T1–T6, verified T7):

| Seam | Status | Notes |
| --- | --- | --- |
| Unknown skill name fail-soft | implemented | `skill` tool: unknown name → retryable non-terminal settlement (`retryable: true`); known-name IO failure stays non-retryable |
| Plan scaffold headers | implemented | `PLANNER_SCAFFOLD_HEADERS` SoT in `plan-scaffold.ts`; factory re-exports |
| `resume-gate` | implemented | Deterministic pure runner after intake; `fresh` / `resume_approval` / `resume_drafting`; frontmatter rehydrates `intent` + `review_required` |
| Interview loop | implemented | `routeInterview` pure helper; `interview.route` enum `continue` / `clear` / `cap_adopt`; max 6 turns; CLEAR always interviews |
| Metis gap analysis | implemented | LLM `metis-gap` → `metis.passed`; `routeMetisReject` budget 1 (`metis.rejects`) → revise once or `present-blocked` |
| Dual-review wave | implemented | `routeDualReview` → `dual.route` skip/run (fail-closed run on missing keys); wave = bundled `reviewer` + `oracle`; all-approve `dual.verdict`; `routeFixDual` budget 1 (`dual.fixes`) with `metis.rejects` reset on revise |

Factory/fixture: `createPlannerWorkflowGraph()` is source of truth; `examples/abg/planner.workflow.json` byte-matches via parity `toEqual`.

## Residual partials

None for row 8 craft seams above.

Intentional non-claims (not partials):

- `plan.approved` may appear as a declared critic-adjacent key; routing authority is `critic.passed` (floor) then `metis.passed` / `dual.route` / `dual.verdict` / `plan.ready`.
- `#default` does not ship metis, dual-review, interview-loop, or resume-gate (planner-only depth).
- Intent verbalization before routing remains deferred (row 17–20 note).
- Mid-run graph hot-patch, skill-as-planning-engine, and combining Metis + dual-review into one parallel batch remain out of scope.

## Catalog

`packages/core/src/behavior/builtin-workflows.ts` + fixtures under `examples/abg/{default,planner,executer,fixer}.workflow.json`.
