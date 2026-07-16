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
| 8 | Plan review critic (approve-biased floor) | `#default`, `#planner` | partial |
| 9–10 | Plan-readonly policies | `#default`, `#planner` | implemented |
| 11–16 | Plan parse, checkbox, F1–F4, 3-strike | `#executer` | implemented |
| 17–20 | Intent gate, anti-dup, evidence | `#fixer` | implemented (verbalization deferred) |

## Catalog

`packages/core/src/behavior/builtin-workflows.ts` + fixtures under `examples/abg/{default,planner,executer,fixer}.workflow.json`.
