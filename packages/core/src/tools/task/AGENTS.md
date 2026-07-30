<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# task

## Purpose

Full-parity `task()` tool registration and built-in category catalog. Delegates a sub-task to a child agent session, routing by category (or explicit `subagent_type`/`agent`) with preset model, permissions, tools, and system-prompt addendum. Supports single-spawn, batch fan-out, background execution, session resume, and **bounded** nested `task` while `taskDepth < PRODUCTION_MAX_TASK_DEPTH` (3). Scaffold `../task-tool.ts` coexists during migration; this directory is the production path.

## Key Files

| File | Description |
|------|-------------|
| `task-tool.ts` | `createFullParityTaskToolRegistration` — schema, routing, permission derivation, runtime delegate |
| `category-catalog.ts` | `BUILTIN_CATEGORIES` / `getCategory` — ten presets |
| `task-tool-contract.ts` | Shared contract types/helpers |
| `task-tool-routing.ts` | Category / subagent_type / agent resolution order |
| `task-tool.test.ts` | Routing, batch, background, resume, depth, formatting |
| `task-tool-batch-concurrency.test.ts` | Batch wave concurrency |
| `task-tool-cancellation.test.ts` | Cooperative cancellation |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Routing priority: explicit `category` → `subagent_type` → `agent` (oh-my-pi alias) → `deep` fallback. Explicit category carries category only; runtime resolves agent by category id. Category name via `subagent_type`/`agent` sets both fields.
- Schema XOR: batch `tasks[]` vs single `prompt`/`assignment`. If both `prompt` and `assignment`, assignment wins; differing prompt merges into `context`.
- Capability class `'subagent'`. Nested depth gated by `PRODUCTION_MAX_TASK_DEPTH = 3` in `../../agents/recursion-policy.ts` (depths 0/1/2 may nest; depth 3 leaf). Not unlimited / not OMC free recursion. `DEFAULT_MAX_RECURSION_DEPTH` is bookkeeping only.
- Child network matrix (filter-time exception; `network` stays hard-dropped globally):
  - **ON** (may retain webfetch/web_search/mcp__*): librarian, deep, reasoner, oracle, designer, planner
  - **OFF**: explore, reviewer, quick
- `buildChildToolSurface` (agents): hard-drops `workflow`/`team`; hard-drops `subagent` unless depth-allowed; hard-drops `network` unless ON category; drops `task`/`job` unless nesting allowed; always adds `yield`. Parent `pathPolicies` denies override child allows.
- No real provider calls in the tool — inject `TaskToolRuntime` (`ConcreteTaskToolRuntime` in agents). Tests use recording doubles.
- Background: `AsyncJobManager` semaphore (default 4); `run_in_background` returns `backgroundId`.
- Batch: max four concurrent children per wave; item failure → `failed` entry, siblings continue.
- Resume via `task_id` + SHA-256 `authorityFingerprint` (includes depth caps); mismatch → non-retryable error.
- Research workflow parents (`research-explore`, planner explore/research) advertise `read+subagent+network+bash` at parent level — separate from child matrix. See `../../behavior/AGENTS.md`.

### Testing Requirements

- Primary: `task-tool.test.ts` (routing XOR, permissions, single/batch, background, resume, depth, `toModelOutput`)
- Also: `task-tool-batch-concurrency.test.ts`, `task-tool-cancellation.test.ts`
- Parent factory/parity tests live one level up (`task-tool-full-parity-*.test.ts`)

### Common Patterns

- Thin tool + injected runtime; authority fingerprint for resume safety
- Category catalog drives allowlists and prompt addenda; network tools only on ON categories
- Layered approval: parent `task()` gate + child tool callbacks + category/pathPolicies + structural hard drops

## Dependencies

### Internal

- `../../agents/task-tool-runtime*.ts`, `child-tool-permissions.ts`, `child-graph-spawn.ts`, `async-job-manager.ts`, `recursion-policy.ts`
- `../../behavior/` — workflow research parent capabilities
- `../` registry / permission self-gating patterns
- `@mission-control/protocol` — tool/agent schemas

### External

- Zod schemas for tool I/O

<!-- MANUAL: -->
