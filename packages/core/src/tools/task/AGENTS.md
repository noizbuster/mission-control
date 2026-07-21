# Task Tool Agent Guide

## Overview

`packages/core/src/tools/task` owns the full-parity `task()` tool registration and its built-in category catalog. The tool delegates a sub-task to a child agent session, routing by category to preset model, permissions, tools, and system-prompt addendum, or by explicit `subagent_type`. It supports single-spawn, batch fan-out, background execution, session resume, and **bounded** nested `task` while `taskDepth < PRODUCTION_MAX_TASK_DEPTH` (3). The simpler scaffold `task` tool lives one directory up at `../task-tool.ts`; this directory holds the full-parity replacement that coexists with it during the migration.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Full-parity tool | `task-tool.ts` | `createFullParityTaskToolRegistration` builds the schema-bound `task` tool. Validates parameters, resolves routing, derives child permissions, and delegates session lifecycle to an injected `TaskToolRuntime`. Schema enforces XOR between batch `tasks[]` and single `prompt` / `assignment`. When both `prompt` and `assignment` are set, assignment wins and differing prompt text merges into `context`. Capability class `'subagent'`. Depth-gates nested `task` via `PRODUCTION_MAX_TASK_DEPTH`. |
| Category catalog | `category-catalog.ts` | `BUILTIN_CATEGORIES` plus `getCategory`. Nine presets: `quick`, `deep`, `reasoner`, `designer`, `explore`, `oracle`, `librarian`, `planner`, `reviewer`. Each carries an optional model alias, permission rules, tool allowlist, and system-prompt addendum. Network family tools (`webfetch`, `web_search`) appear only on ON categories (see matrix below). |
| Runtime authority | `../../agents/task-tool-runtime-authority.ts`, `../../agents/child-tool-permissions.ts`, `../../agents/child-graph-spawn.ts` | `buildChildToolSurface` intersects tool allowlists, applies hard drops with depth and network exceptions, adds `yield`, and installs category plus derived `pathPolicies` checks. `CHILD_NETWORK_ALLOWED_CATEGORIES` and `PRODUCTION_MAX_TASK_DEPTH` live under `../../agents/`. |
| Tests | `task-tool.test.ts` | Routing resolution, permission derivation, batch fan-out, background handle, resume, nested depth, and model output formatting. |

## Conventions

- Routing resolves in priority order: explicit `category`, then `subagent_type`, then `agent` (oh-my-pi alias), then the `deep` fallback. Explicit category routing carries the category only; the runtime resolves its agent by category id. A category name supplied through `subagent_type` or `agent` carries both fields.
- Child permissions contain category rules plus a trailing nested-subagent deny **unless** nesting is depth-allowed (`nestSubagent` / `withNestSubagentPermission`). Parent agent `pathPolicies` are enforced independently by `ConcreteTaskToolRuntime`, where inherited denies override child allows. No category and no `AgentDefinition.recursion` value can raise the live depth cap through policy alone.
- **Nested depth (production):** only `PRODUCTION_MAX_TASK_DEPTH = 3` in `../../agents/recursion-policy.ts`. Spawn while `taskDepth < 3` (depths 0/1/2 may keep nested `task`); depth 3 is the blocked leaf (MAIN → d1 → d2 → d3). Still no unlimited recursion; not OMC free recursion. `DEFAULT_MAX_RECURSION_DEPTH` (2) is compatibility bookkeeping only.
- **Child network matrix (category-scoped, not universal deny):** `network` stays in `CHILD_HARD_DROPPED_CAPABILITY_KINDS`; the allowlist is a filter-time exception (`allowNetworkCapability`).
  - **ON** (may retain parent `webfetch` / `web_search` / `mcp__*`): `librarian`, `deep`, `reasoner`, `oracle`, `designer`, `planner`
  - **OFF** (network hard-dropped): `explore`, `reviewer`, `quick`
  - Webfetch claims only for ON paths. Prefer routing external docs/web lookup via `librarian` (or another ON category the parent chooses: `deep` / `reasoner` / `oracle` / `designer`).
- The `TaskToolRuntime` abstraction keeps the tool free of real provider calls. `ConcreteTaskToolRuntime` (in `../../agents/task-tool-runtime.ts`) is the live implementation; tests inject a recording double. The runtime resolves the agent, resolves the model, builds the child system prompt, constructs the child tool surface, and delegates the graph run to an injectable `spawnFn`.
- `buildChildToolSurface` always hard-drops `workflow`/`team`, hard-drops `subagent` unless depth-allowed, hard-drops `network` unless the category id (else agent name) is in `CHILD_NETWORK_ALLOWED_CATEGORIES`, drops `task`/`job` unless depth-allowed nesting, and adds `yield`. Category rules and child-plus-parent-deny `pathPolicies` can filter universally denied tools up front and are enforced again against concrete invocation resources. Destructive tools are policy-controlled rather than hard-dropped.
- Background execution routes through `AsyncJobManager` (in `../../agents/async-job-manager.ts`) via the runtime's `startBackgroundSession`. The manager bounds concurrency with a semaphore (default 4), queues overflow, and forwards cooperative cancellation through a per-job `AbortController`. `run_in_background: true` returns a `backgroundId` immediately; the caller polls the job through `awaitJob`.
- Approval remains layered. The parent `task()` call is permission-gated, retained child tools keep the workspace permission callbacks cloned with their registrations, category rules and derived `AgentDefinition.pathPolicies` separately restrict invocation, and structural filtering applies the depth and network exceptions above. The standalone tier resolver does not merge workspace `PermissionRule` or workflow `PolicyEffectRule` into either policy vocabulary.
- Batch mode (`tasks[]`) runs at most four children at a time, then starts the next wave. Each item carries its own `agent` and `assignment`; the optional top-level `context` propagates as `parentContext` to every child. A failed child becomes a `failed` batch entry carrying the error message; it does not abort sibling tasks or later waves.
- Session resume uses `task_id`. The runtime requires an idle or parked child owned by the same parent and recomputes its SHA-256 `authorityFingerprint` digest (includes `taskDepth` + `PRODUCTION_MAX_TASK_DEPTH`). It resumes only when that digest matches the stored authority; an unknown id or mismatch raises a non-retryable `ToolExecutionError`.

## Research parents (workflow graphs)

Workflow llm nodes that research (not implement) advertise parent capabilities
`['read', 'subagent', 'network', 'bash']` so they can call `task()`, use parent network tools,
and run read-only bash (`git log`, `rg`, `find`, `pnpm list`, …) for direct exploration without
forcing a `task()` round-trip. Mutations stay forbidden by prompt and the approval gate
(permission profile default `ask`):

- `research-explore` on `default` / `fixer` (`../../behavior/fixer-workflow-graph.ts`)
- planner `explore` and `research` (`../../behavior/planner-workflow-graph.ts`)

The `default` / `fixer` graph also gives `maturity-sample` and `evidence-check` `['read', 'bash']`
for sampling and personal verification (lsp/build/test evidence the prompts already demanded).

Soft bias on those parents: prefer `explore` / `librarian` children; route external lookup via
`librarian` (or ON categories when chosen). See `../../behavior/AGENTS.md` **Workflow subagent
research path**. Executer F1–F4 critics are hybrid dual-review (`subagent` + `outputEnum`
APPROVE/REJECT); F3 is tests-as-claims evidence only (**no bash**).

## Tests

- `task-tool.test.ts` covers every routing path, the `category` XOR `subagent_type` XOR `agent` constraint, child permission derivation, the single-spawn happy path, four-item batch waves with per-item failure isolation, background handle return, resume of known and unknown sessions, nested depth gating, and `toModelOutput` formatting for batch, running, failed, and completed results.

## Anti-Patterns

- Do not remove the depth-gated nested-subagent deny, the registry-layer `task` omission at the leaf, hard drops, or invocation policy. They are independent child-authority guards. Do not claim unlimited nesting or OMC free recursion.
- Do not claim all children have network. Only `CHILD_NETWORK_ALLOWED_CATEGORIES` may retain webfetch/web_search/mcp; OFF categories stay hard-dropped. Do not delete `network` from the hard-drop set globally.
- Do not call real provider methods from the tool. Everything effectful goes through `TaskToolRuntime`; the tool only validates, routes, derives permissions, and delegates.
- Do not mix batch and single-spawn in one call. The schema enforces XOR between `tasks[]` and `prompt` / `assignment`; both present is a validation error, not a runtime branch.
- Do not let a batch item failure abort sibling tasks. Each item resolves independently; a rejection becomes a `failed` entry in the batch result.
- Do not treat the simpler `../task-tool.ts` and this full-parity tool as alternatives the model chooses between. The full-parity registration is the production path; the simpler one is scaffold that coexists during the migration and must not diverge in the child safety contract.
