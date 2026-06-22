# Task Tool Agent Guide

## Overview

`packages/core/src/tools/task` owns the full-parity `task()` tool registration and its built-in category catalog. The tool delegates a sub-task to a child agent session, routing by category to preset model, permissions, tools, and system-prompt addendum, or by explicit `subagent_type`. It supports single-spawn, batch fan-out, background execution, and session resume. The simpler scaffold `task` tool lives one directory up at `../task-tool.ts`; this directory holds the full-parity replacement that coexists with it during the migration.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Full-parity tool | `task-tool.ts` | `createFullParityTaskToolRegistration` builds the schema-bound `task` tool. Validates parameters, resolves routing, derives child permissions, and delegates session lifecycle to an injected `TaskToolRuntime`. Schema enforces XOR between batch `tasks[]` and single `prompt` / `assignment`. Capability class `'subagent'`. |
| Category catalog | `category-catalog.ts` | `BUILTIN_CATEGORIES` plus `getCategory`. Nine presets: `quick`, `deep`, `ultrabrain`, `visual-engineering`, `explore`, `oracle`, `librarian`, `metis`, `momus`. Each carries an optional model alias, permission rules, tool allowlist, and system-prompt addendum. |
| Tests | `task-tool.test.ts` | Routing resolution, permission derivation, batch fan-out, background handle, resume, and model output formatting. |

## Conventions

- Routing resolves in priority order: explicit `category`, then `subagent_type`, then `agent` (oh-my-pi alias), then the `deep` fallback. When the routed name matches a built-in category id, both the category preset and the `subagentType` are set so the runtime can resolve the agent definition and apply the preset.
- Child permissions merge category rules first with derived denies last. `deriveChildPermissions` (from `../../permissions/rule-derive.ts`) forwards parent denies and appends a nested-subagent deny. Last-match-wins means inherited restrictions always override category allows. No category can re-enable nested `task` calls through policy alone.
- The `TaskToolRuntime` abstraction keeps the tool free of real provider calls. `ConcreteTaskToolRuntime` (in `../../agents/task-tool-runtime.ts`) is the live implementation; tests inject a recording double. The runtime resolves the agent, resolves the model, builds the child system prompt, constructs the child tool surface, and delegates the graph run to an injectable `spawnFn`.
- The child tool surface always drops the `task` tool (registry-layer recursion guard) and adds the `yield` tool (child result submission). Capability classes denied by the derived path policies are filtered out. Two layers of defense back each other: structural omission at the registry plus denial at the policy gate.
- Background execution routes through `AsyncJobManager` (in `../../agents/async-job-manager.ts`) via the runtime's `startBackgroundSession`. The manager bounds concurrency with a semaphore (default 4), queues overflow, and forwards cooperative cancellation through a per-job `AbortController`. `run_in_background: true` returns a `backgroundId` immediately; the caller polls the job through `awaitJob`.
- Tier-based approval applies per child session. `ConcreteTaskToolRuntime` forces child sessions to `yolo` mode, so the parent's `task()` approval is the single authorization boundary. The approval tier resolver lives in `../../agents/approval-tier.ts` and is a separate dimension from the policy-gate rules and the workspace permission store.
- Batch mode (`tasks[]`) runs children in parallel via `Promise.all`. Each item carries its own `agent` and `assignment`; the optional top-level `context` propagates as `parentContext` to every child. A failed child becomes a `failed` batch entry carrying the error message; it does not abort sibling tasks.
- Session resume uses `task_id`. The runtime checks `sessionExists` before calling `resumeChildSession`. An unknown id raises a non-retryable `ToolExecutionError`.

## Tests

- `task-tool.test.ts` covers every routing path, the `category` XOR `subagent_type` XOR `agent` constraint, child permission derivation, the single-spawn happy path, batch fan-out (including per-item failure isolation), background handle return, resume of known and unknown sessions, and `toModelOutput` formatting for batch, running, failed, and completed results.

## Anti-Patterns

- Do not bypass `deriveChildPermissions`. The nested-subagent deny it appends is the policy-layer guard that backs up the registry-layer `task` omission. Removing it lets a category re-enable nested spawns through policy alone.
- Do not call real provider methods from the tool. Everything effectful goes through `TaskToolRuntime`; the tool only validates, routes, derives permissions, and delegates.
- Do not mix batch and single-spawn in one call. The schema enforces XOR between `tasks[]` and `prompt` / `assignment`; both present is a validation error, not a runtime branch.
- Do not let a batch item failure abort sibling tasks. Each item resolves independently; a rejection becomes a `failed` entry in the batch result.
- Do not treat the simpler `../task-tool.ts` and this full-parity tool as alternatives the model chooses between. The full-parity registration is the production path; the simpler one is scaffold that coexists during the migration and must not diverge in the child safety contract.
