<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# src

## Purpose

Implementation root for `@mission-control/core`. Top-level files are the runtime facade, approval/desktop services, and session admission/replay projections. Subdirectories are domain modules; several carry nested `AGENTS.md` with deeper rules.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Public API barrel (large, intentional); also `replay.ts` / `redaction.ts` subpath entries |
| `agent-runtime.ts` | `AgentRuntime` facade — session lifecycle, events, sidecar/provider/graph dispatch |
| `agent-runtime-options.ts` / `agent-runtime-support.ts` / `agent-runtime-sidecar.ts` / `agent-runtime-skill.ts` | Options typing and facade helpers |
| `approval-gate.ts` | `PermissionGate` — approval lifecycle broker |
| `approval-gate-events.ts` / `approval-gate-helpers.ts` | Gate event projection helpers |
| `desktop-session-commands.ts` | Desktop session command service (prompt/run/approval-effect) |
| `desktop-tool-approvals.ts` | Desktop approval store + settlement |
| `desktop-tool-approval-*.ts` / `desktop-approval-*.ts` / `desktop-reexecutable-tool-registry.ts` | Authority, backfill, crash recovery, effects, transcript, re-exec registry |
| `event-bus.ts` | In-process event bus |
| `cancellation.ts` | `CancellationToken` / task-handle primitives |
| `permissions.ts` | `createDefaultPermissionDecision` / `createAllowPermissionDecision` |
| `redaction.ts` | Browser-safe redaction subpath surface |
| `replay.ts` | Replay subpath re-exports |
| `session.ts` | Thin session export shim |
| `session-admission.ts` (+ `*-service`, `*-projection`, `*-types`) | Prompt/session admission pipeline |
| `session-log.ts` | Session log helpers |
| `session-replay.ts` (+ `session-replay-*.ts`) | Replay engine, coding/session/approval/run-state projections, types |
| `session-branch-projection.ts` / `session-continuation-projection.ts` / `session-compaction-*.ts` | Branch, continuation, compaction projections |
| `session-replay-fixtures/` | **Read-only golden JSONL** (skip generation; not a code module) |

Colocated `*.test.ts` / `*-test-support.ts` files mirror the above. `agent-runtime-demo.ts` is a small demo entry, not production API.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `abg-overlay/` | ABG overlay state machine + usage emit (`state.ts`) |
| `agents/` | Agent discovery, registry, lifecycle, child spawn, task-tool runtime (see `agents/AGENTS.md`) |
| `behavior/` | ABG graphs, node runners, modes, budget, fan-out/race (see `behavior/AGENTS.md`) |
| `context/` | System prompt, context packer, system-context registry (see `context/AGENTS.md`) |
| `db/` | Drizzle/libSQL client, session schema literals, identity/registry |
| `discovery/` | Shared JSONC load + resource walker for multi-scope discovery |
| `memory/` | Session event store, blackboard, data-dir, projections, import/export |
| `native/` | Sidecar client, process/mock clients, natives FFI client, wire helpers |
| `permission/` | Workspace permission session, rule store, evaluator, workspace root |
| `permissions/` | Workflow policy-gate algebra (`wildcardMatch`, `evaluateRules`) |
| `persistence/` | `.mc/` paths, boulder/plan/notepad stores, atomic writes |
| `plugins/` | Plugin paths, loader, manager, TUI plugin host |
| `providers/` | Provider turn runner + per-provider adapters (see `providers/AGENTS.md`) |
| `runtime/` | Run coordinators, mission-run, continuation, session-control (see `runtime/AGENTS.md`) |
| `skills/` | Skill loader + metadata (see `skills/AGENTS.md`) |
| `tools/` | Tool registry and built-ins including mcp/task/team/workflow (see `tools/AGENTS.md`) |
| `trust/` | `project-trust-store.ts` |
| `tui-stores/` | File-backed TUI preference/history/stash/theme/plugin stores |
| `util/` | Small shared helpers (`escape-xml`, `node-error`, `error-to-string`) |
| `workflows/` | Workflow loader/registry + `materializeWorkflow` + jsonc parser |

## For AI Agents

### Working In This Directory
- Parent package invariants in `../AGENTS.md` always apply.
- Use nested `AGENTS.md` before editing `behavior/`, `providers/`, `tools/`, `runtime/`, `context/`, `agents/`, `skills/`.
- New top-level modules need a clear boundary reason; most features belong under an existing subdirectory.
- Keep `index.ts` exports explicit and review-sized — no wildcard re-export of entire internal trees unless already established.
- Never treat `session-replay-fixtures/` as writable source.

### Testing Requirements
- Colocate tests next to the unit under change.
- Cross-module contracts (protocol export, replay parity, desktop approval durability) often have dedicated `*.test.ts` at this level — run the nearest test file first.
- Fixture JSONL under `session-replay-fixtures/` is asserted by `session-replay-fixtures.test.ts` / parity tests.

### Common Patterns
- `*Projection` pure functions over event arrays
- `*Service` / `createX` factories with injected stores and clocks for tests
- SQL authority in `memory/` + `db/`; JSONL is not source of truth for runs
- Desktop approval settlement is crash-safe and provenance-checked — read existing settlement tests before changing

## Dependencies

### Internal
- `@mission-control/protocol`, `@mission-control/config`
- Nested modules depend on each other via relative imports; apps depend only on package exports
- `../AGENTS.md` for package-level invariants

### External
- See `../package.json` — AI SDK family, libsql/drizzle, MCP SDK, diff, yaml, zod, puppeteer-core

<!-- MANUAL: -->
