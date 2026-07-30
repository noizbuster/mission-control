<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# subagents

## Purpose

Runtime half of the `task` tool pair: spawn a child coding-agent graph run from a caller-supplied child tool registry and model. Full-parity path uses `buildChildToolSurface` from `../../agents/`; this module builds/runs the graph and maps the final assistant message to the task `summary`. Deprecated simple-task compatibility filtering remains in `child-policy.ts`.

## Key Files

| File | Description |
|------|-------------|
| `spawn-child.ts` | `spawnChildCodingAgent`, `ChildHostCallbacks` — graph build/run + host routing |
| `spawn-child.test.ts` | Spawn lifecycle, isolation, summary mapping |
| `child-policy.ts` | **Deprecated** simple-task compatibility filter — prefer `buildChildToolSurface` |
| `child-policy.test.ts` | Legacy filter tests |
| `plan-mode-bypass.test.ts` | Plan-mode bypass behavior around child policy |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Do **not** derive child authority from parent/session permission rules here — authority is prepared in `../../agents/task-tool-runtime-authority.ts` and passed in as the child registry.
- `tools/task-tool.ts` = model-facing contract + recursion guard; this module = graph runtime.
- Without host callbacks, child is isolated: `ask_user` returns `ASK_USER_BLOCKED_ANSWER`; signals/events dropped at boundary.
- Optional `ChildHostCallbacks`: ask_user overlay, durable-event render, signal taps, observability redactor, parent-first ask_user answerer.
- Prefer full-parity `buildChildToolSurface` over `child-policy.ts` for new work.
- Nested depth and network matrix are owned by `../../agents/recursion-policy.ts` and `child-graph-spawn.ts` — do not reimplement caps here.
- Child identity is independent: parent persona is not injected (`spawn-prompt-builder` layers).

### Testing Requirements

- `spawn-child.test.ts`, `child-policy.test.ts`, `plan-mode-bypass.test.ts`
- Broader authority tests live under `../../agents/task-tool-runtime*.test.ts`
- Focused: `pnpm exec vitest run packages/core/src/behavior/subagents/<file>.test.ts`

### Common Patterns

- Uses `createCodingAgentGraph` + `createCodingAgentNodeRegistry` + `runAbgGraph`.
- Final assistant message → task `summary`; protocol errors mapped through shared error codes.
- Activity touch composition available via `../../agents/child-activity-touch.ts` at the host boundary.

## Dependencies

### Internal

- `../coding-agent-graph.ts`, `../coding-agent-registry.ts`, `../graph-runner.ts`
- `../nodes/llm-actor/llm-actor-node.ts` — `LlmActorModel`
- `../../agents/` — authority surface, activity touch
- `../../tools/` — task output types, ask-user router/registrations
- `../../providers/observability-redactor.ts`
- `../../runtime/session-control-cancellation.ts` — epoch type
- `@mission-control/protocol` — signals, events, errors

### External

- `ai` — `ModelMessage` types

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
