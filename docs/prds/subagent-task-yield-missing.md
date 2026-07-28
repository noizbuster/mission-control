# PRD: Stabilize task() subagent yield and child observability

> **SUPERSEDED (2026-07-27).** The "force `yield` before exit" direction in Goals below
> was reversed as a root-cause fix for the same ~43–47% `task()` failure rate. Structural
> analysis (`session_1785066275305` and 8 others) showed `requireYieldBeforeExit` *trapped*
> models that answer in prose: it forced `llm.loop_active` back on, burned turns until
> soft-land / `maxNodeRuns`, and then `createChildGraphSpawnFn` discarded the child's actual
> work as a `task_yield_missing` failure. The fix instead (1) stops forcing
> `requireYieldBeforeExit` on default child spawns — a prose-only turn completes the child —
> and (2) treats a completed graph that never called `yield` as a degraded **success** whose
> output is the child's final text. Only a genuinely failed graph is a child failure. See
> `packages/core/src/agents/child-graph-spawn.ts`, `behavior/subagents/spawn-child.ts`. The
> SQL-observability goals below remain valid and unaddressed by this change.

| Field | Value |
| --- | --- |
| Status | ready-for-implementation |
| Scope | `packages/core` task child spawn, llm-actor loop, task schema, SQL session mirror |
| Execution plan | `.mc/plans/subagent-task-yield-missing-fix.md` |
| Evidence session | `session_1784631200350` in `~/.local/share/mission-control/mission-control.db` |

## Background

Under `zai-coding-plan/glm-5.2#reasoning-max`, multi-turn `task()` delegation failed at high rate (~47% of tool calls in the evidence session). Investigation classified 10 `task` failures as 9× `task_yield_missing` and 1× `schema_invalid`. Child sessions left no durable SQL rows, blocking post-hoc debug. Root cause for yield_missing is structural: prose-only child turns clear `llm.loop_active`, the coding-agent graph exits, and `yield` is never called. Parent 3-strike retries do not change that model pattern.

## Goals

- Child coding-agent graphs do not exit without `yield` (or budget exhaustion → degraded salvage).
- `task({ prompt, assignment })` validates by normalizing (assignment wins), not hard-rejecting.
- Child spawns are durable in session SQL (`sessions`, relations, `runtime_agents`, jobs) for observability.
- Fixes are provider-independent runtime guards, not model swaps.

## Non-Goals

- Changing default provider/model.
- Removing degraded salvage.
- Altering `stopWhen: stepCountIs(1)` (graph owns the loop).
- Implementing `/sessions` list filtering (separate product request that triggered the failing session).
- Editing concurrent WIP under `apps/tui` / `apps/cli`.

## Requirements

1. Child-context yield guard keeps `llm.loop_active` true until `yield` or `maxNodeRuns`, with a one-shot system reminder on prose-only turns.
2. Parent/default coding-agent graphs must not enable the guard (no parent infinite loop).
3. Task tool input accepts simultaneous `prompt` + `assignment` via normalize transform.
4. Foreground and background child spawns persist observable SQL rows when a SQL-backed runtime is present.
5. Existing yield_missing → retryable taxonomy and degraded salvage remain for true abnormal exits.

## Acceptance Criteria

- Focused core tests green (llm-actor, child-graph-spawn, task-tool); typecheck clean.
- Repro-class glm-5.2 delegation no longer cascades instant `task_yield_missing` on prose-only first turns.
- Post-spawn SQL shows child session/relation/runtime_agent rows where previously zero.
- Plan file checklist in `.mc/plans/subagent-task-yield-missing-fix.md` completed.
