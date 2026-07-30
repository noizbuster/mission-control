<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# core

## Purpose

`@mission-control/core` owns runtime behavior: event logs, session admission/replay, permissions, provider turns, approval-gated tools, native sidecar fallback, desktop command services, skills/workflows/agents discovery, MCP clients, and bounded ABG/action-graph scaffolding. Public surface is the package root export plus `./replay` and `./redaction` subpath exports.

## Key Files

| File | Description |
|------|-------------|
| `package.json` | `@mission-control/core`; workspace deps on config + protocol; AI SDK, libsql, drizzle, MCP SDK, etc. |
| `project.json` | Nx project `core`: prebuild generates bundled agents, then vite+tsc; test/typecheck targets |
| `tsconfig.json` | Package TS config |
| `vite.config.ts` | Library build (multiple entry points) |
| `src/` | Runtime source tree (see `src/AGENTS.md`) |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | All runtime modules and public barrels (see `src/AGENTS.md`) |

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Public exports | `src/index.ts` | Export new public runtime APIs here intentionally. |
| Runtime facade | `src/agent-runtime.ts` | Session lifecycle, event emission, sidecar selection, provider/graph task dispatch. |
| Run coordination | `src/runtime/` | Prompt admission, wake/run/resume/interrupt, scheduler, mission-run, continuation (see `src/runtime/AGENTS.md`). |
| Provider turns | `src/providers/` | Adapters, retries, timeouts, redaction, OpenAI/Anthropic/Google/compatible mapping (see `src/providers/AGENTS.md`). |
| Native sidecar | `src/native/` | Process spawn, handshake, status, timeout, mock fallback, natives client. |
| Durable sessions | `src/memory/`, `src/db/` | SQLite/libSQL session event store, projections, archive import/export (JSONL payload only). Durable Mission/Run rows live in SQL `mission_runs`. |
| Replay | `src/session-replay*.ts`, `src/session-*.ts`, `src/replay.ts` | Branch, approval, tool outcome, prompt admission projections. |
| Tools | `src/tools/` | Registry, repo tools, patch/bash, task/job, MCP, workflow/yield, media, ssh (see `src/tools/AGENTS.md`). |
| Skills | `src/skills/` | `SKILL.md` multi-scope discovery; instruction data, not file-edit tools (see `src/skills/AGENTS.md`). |
| Agents | `src/agents/` | Discovery, registry, lifecycle, child spawn, task-tool runtime (see `src/agents/AGENTS.md`). |
| ABG/action graphs | `src/behavior/` | Validation, node registry, coordination, modes, fan-out/race (see `src/behavior/AGENTS.md`). |
| Context / prompts | `src/context/` | System prompt assembly, context packer, system-context registry (see `src/context/AGENTS.md`). |
| Workflows | `src/workflows/` | `discoverWorkflows`, `WorkflowRegistry`, `materializeWorkflow`. |
| `.mc/` persistence | `src/persistence/` | Boulder/plan/notepad stores, atomic writes, path helpers. |
| Desktop commands | `src/desktop-session-commands.ts`, `src/desktop-tool-approvals.ts` | Core service behind desktop write/approval paths. |
| Plugins | `src/plugins/` | Manifest load, manager, TUI plugin host. |
| Trust | `src/trust/` | Project trust store. |
| TUI stores | `src/tui-stores/` | Local preference/history/stash/theme/plugin-manifest file stores. |

## Invariants

- Event streams are append-only. Derive projections from events instead of mutating hidden state.
- Local storage opens `mission-control.db` directly with one leased client per canonical file/process, an explicit in-process write lane, WAL/NORMAL, and a 5000 ms busy timeout. Runtime startup does not probe or import older standalone SQL database files; schema setup only migrates legacy projection-table names in place within the canonical database.
- Values crossing app/package/sidecar boundaries must be parsed with `@mission-control/protocol` schemas.
- Default permissions stay conservative; `createDefaultPermissionDecision` denies.
- Mock/fallback sidecar behavior is part of the scaffold contract. Do not remove it while native execution remains partial.
- `file.patch` and `command.run` stay on the TypeScript core path by default; the Rust sidecar currently negotiates `task.run` only.
- Production child sessions never receive `task` or `job`; `AgentDefinition.recursion` remains compatibility metadata and cannot restore nested routing.
- Do not implement unrestricted file editing, persistent vector memory, full scheduler orchestration, or a full ABG engine unless explicitly requested.
- Keep public exports named and typed. Avoid `any`, `as any`, `as unknown`, suppression comments, and non-null assertions.
- Workflow `PolicyEffectRule` and workspace `PermissionRule` are separate systems; pick the layer you are editing.
- JSONL is replay/import/export compatibility, not authoritative Mission/Run storage.

## For AI Agents

### Working In This Directory
- Prefer extending an existing module over new top-level files; export deliberately from `src/index.ts`.
- `prebuild` runs `scripts/generate-bundled-agents.mjs` — bundled agent markdown under `agents/bundled` is generated input; do not hand-edit generated JS outputs.
- Deep module guidance lives in nested `src/*/AGENTS.md` (behavior, context, providers, runtime, tools, tools/mcp, tools/task, agents, skills, and further leaves owned by other init passes).
- UI apps must consume this package’s public API only; do not reach into non-exported paths from apps.

### Testing Requirements
- Runtime behavior: `src/agent-runtime*.test.ts`, `src/runtime/*.test.ts`.
- Sidecar fallback/timeouts: `src/native/*.test.ts`.
- Durable sessions and replay: `src/memory/*.test.ts`, `src/session-*.test.ts`, `src/db/*.test.ts`.
- Tool policy and output: `src/tools/**/*.test.ts`.
- Graph behavior: `src/behavior/**/*.test.ts`.
- Focused: `pnpm exec vitest run packages/core/src/<file>.test.ts`
- Package: `NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run core:test`
- Do not edit or depend on `session-replay-fixtures/` contents except as read-only golden JSONL.

### Common Patterns
- Schema-parse at boundaries; project events into read models
- Approval gate + permission session before mutating tools
- Child tool surfaces: drop `task`/`job`, add `yield`, hard-drop `subagent`/`workflow`/`network`/`team` capability classes where spawn policy says so
- Atomic temp-file-then-rename for `.mc/` writes; `.passthrough()` on boulder schemas

## Child Guidance

- `src/AGENTS.md` — module index for the source tree
- `src/behavior/AGENTS.md` — ABG/action-graph code
- `src/providers/AGENTS.md` — provider adapters, credentials, redaction
- `src/tools/AGENTS.md` — tool registration and built-ins
- `src/tools/mcp/AGENTS.md` — MCP clients/config
- `src/tools/task/AGENTS.md` — full-parity `task()` tool
- `src/runtime/AGENTS.md` — run coordination, mission-run, continuation
- `src/context/AGENTS.md` — prompts and system-context sources
- `src/agents/AGENTS.md` — agent discovery/lifecycle/spawn
- `src/skills/AGENTS.md` — skill loader

## Dependencies

### Internal
- `@mission-control/protocol` — all boundary schemas
- `@mission-control/config` — catalog, variants, product constants
- `native/sidecar` / `native/natives` — process and FFI helpers behind `src/native`
- `scripts/generate-bundled-agents.mjs` — prebuild bundled agents

### External
- `ai` + `@ai-sdk/*` — model provider SDK bridge
- `@libsql/client`, `drizzle-orm` — local SQL
- `@modelcontextprotocol/sdk` — MCP transports
- `diff`, `yaml`, `zod`, `puppeteer-core` (browser tool path)

## Anti-Patterns

- Do not write around the durable local session store by hand.
- Do not emit protocol-shaped objects without schema validation when crossing a boundary.
- Do not treat provider catalog entries as implemented adapters.
- Do not serialize raw provider credentials into events, JSONL, CLI output, desktop state, or evidence.
- Do not edit `dist`.
- Do not route continuation state through `updateBoulderWork` patch types that drop passthrough fields — read/write boulder directly when needed.

<!-- MANUAL: -->
