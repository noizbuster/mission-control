<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# tools

## Purpose

Model-callable tool registration and execution for Mission Control: read-only repo tools, `file.patch` / hashline edits, `command.run` / bash, coding-agent capability tools (`glob`, `todowrite`, `webfetch`, `task`, `skill`, `lsp`, browser, web search, memory, monitors, jobs, IRC, GitHub, TTS/vision/image, session tools), MCP proxy + namespaced `mcp__*` clients, team/workflow/yield/resolve coordination tools, and the schema-bound `tool-registry`.

## Key Files

| File | Description |
|------|-------------|
| `tool-registry.ts`, `tool-registry-types.ts`, `tool-registry-invocation.ts` | Schema-bound invocation, version hashing, model output caps, argument budgets |
| `file-patch*.ts`, `file-edit*.ts`, `file-write*.ts`, `file-mutation.ts` | Unified diff / fuzzy edit / write paths with workspace guards and approval |
| `hashline-edit.ts`, `hashline-edit-schemas.ts` | Hashline edit tool entry (core algorithm in `hashline/`) |
| `command-run*.ts`, `bash-run*.ts`, `shell-session.ts` | Structured argv command execution, allowlists, PTY/shell sessions |
| `read-tools*.ts`, `ripgrep-tool*.ts`, `glob-tool*.ts` | Repo read/list/search with path guards and denylist |
| `task-tool.ts`, `task-tool-factory.ts`, `task-tool-full-parity-factory.ts` | Scaffold + factory wiring; full-parity body in `task/` |
| `mcp-tool.ts` | `McpClient` seam + in-process test client; real clients in `mcp/` |
| `skill-tool.ts`, `manage-skill-tool.ts` | On-demand skill load / manage |
| `ast-edit*.ts`, `ast-grep-*.ts` | AST rewrite + ast-grep query/rewrite tools and staged previews |
| `browser-tool*.ts` | Puppeteer browser tool lifecycle, authority, redaction |
| `web-search-*.ts`, `webfetch-tool*.ts` | Web search providers/transport and fetch factory |
| `ask-user-*.ts`, `child-ask-user-*.ts` | Interactive ask-user + child→parent answer routing |
| `job-tool.ts`, `monitor-*.ts`, `checkpoint-tool.ts` | Background jobs, monitors, checkpoints (session-bound) |
| `irc-tool.ts`, `github-tool.ts`, `ssh-tool.ts` | Collaboration / remote tools |
| `memory-*-tool.ts`, `memory-backend.ts` | Agent memory retain/recall/reflect/edit tools |
| `session-*-tool.ts`, `session-tools-shared.ts` | Session info/list/read/search tools |
| `eval-*.ts` | JS/Python eval host, kernels, bridges |
| `lsp-*.ts` | Opt-in LSP client, server manager, rename/diagnostics |
| `public-*-exports.ts` | Public export barrels for core/integration/orchestration/support |
| `staged-preview-registry.ts` | Session-scoped staged preview slots (consumed by `resolve/`) |
| `tool-permissions.ts`, `tool-settlement-events.ts` | Permission helpers and settlement event shapes |
| `scheme-resolver.ts` | URI/scheme resolution for tool paths |
| `index.ts` | Barrel re-exports |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `hashline/` | Hashline edit-by-hash algorithm (see `hashline/AGENTS.md`) |
| `mcp/` | MCP stdio/HTTP clients, config, surfacing (see `mcp/AGENTS.md`) |
| `notepad-guard/` | Append-only `.mc/notepads/` write guard (see `notepad-guard/AGENTS.md`) |
| `resolve/` | Apply/discard staged preview tool (see `resolve/AGENTS.md`) |
| `task/` | Full-parity `task()` tool + category catalog (see `task/AGENTS.md`) |
| `team/` | Config-gated `team_*` multi-agent tools (see `team/AGENTS.md`) |
| `workflow-tool/` | Named workflow self-invoke tool (see `workflow-tool/AGENTS.md`) |
| `yield-tool/` | Child-agent result submission tool (see `yield-tool/AGENTS.md`) |

## For AI Agents

### Working In This Directory

- Inputs/outputs must be Zod/schema-bound. Reject malformed arguments before execution.
- Tool advertisements are versioned; stale advertised versions must fail.
- `capabilityClasses` are **fine** labels (`file.edit`, `repo.read`, `bash.run`, …). Workflow nodes declare **coarse** labels (`read`, `write`, …). Bridge via `behavior/nodes/llm-actor/capability-expand.ts` and `docs/tool-permission-model.md`. Adding a class may require expand-map + tests.
- Advertising ≠ authorization: effectful tools still call `requestPermission` and respect workspace trust.
- Skills (`skill` / `SKILL.md`) are instruction DATA, not file-edit capability.
- `command.run` accepts structured `command` + `args`; never one shell string. Allowlist, non-interactive, timeouts, byte caps, redaction.
- `file.patch` requires approval; preserve workspace containment, symlink escape rejection, size limits, dirty tracked-file refusal, before/after diff events.
- Read-only tools stay read-only with workspace path guards.
- Desktop graph + approval registries both use `createDesktopReExecutableToolRegistry` (parent `../desktop-reexecutable-tool-registry.ts`). Limit to workspace reads + effects reconstructible from persisted args.
- Session-bound: staged previews, jobs, monitors, shell sessions, SSH, checkpoints, plan-exit, live LSP — do not add to fresh desktop approval re-execution without shared lifecycle ownership.
- Child surfaces hard-drop `workflow`/`team`; network/MCP is category-scoped (see `task/AGENTS.md`, `mcp/AGENTS.md`).

### Testing Requirements

- Prefer focused: `pnpm exec vitest run packages/core/src/tools/<file>.test.ts`
- Registry: `tool-registry.test.ts`
- File patch/edit: `file-patch.test.ts`, parser/path/apply/fuzzy tests
- Command/bash: `command-run.test.ts`, `command-run-interrupt.test.ts`, `bash-run.test.ts`
- Read/search: `read-tools.test.ts`, `ripgrep-tool-factory.test.ts`, `glob-tool-factory.test.ts`
- Desktop lockstep: `../desktop-reexecutable-tool-registry.test.ts`, `../desktop-tool-approval-settlement.test.ts`
- Security defaults: `tool-defaults-security.test.ts`
- Do not run live network/provider calls in default CI tests

### Common Patterns

- Factory pattern: `createXToolRegistration` / `*ToolFactory` injects runtime deps; tools validate then delegate.
- Permission self-gating at registration; fine capability class on the registration object.
- Path tools share denylist/workspace helpers from `read-tools-paths.ts` and related modules.
- Staged mutations (`ast_edit`) register apply/discard closures; `resolve` consumes them.
- Public surfaces re-exported carefully via `public-*-exports.ts` and package `src/index.ts`.

## Dependencies

### Internal

- `../behavior/` — capability expand, child policy, workflow graphs
- `../agents/` — task runtime, child spawn, job manager
- `../permission/`, `../permissions/`, `../trust/` — authority and project trust
- `../persistence/` — plans, notepads, boulder, `.mc` paths
- `../workflows/` — workflow registry for `workflow` tool
- `../native/` — natives addon + sidecar for grep/ast/shell capabilities
- `../memory/` — session store hooks for session tools / memory backend
- `@mission-control/protocol` — schemas and event types
- `@mission-control/config` — tool/policy config where applicable

### External

- Zod (schemas), AI SDK tool shapes where bridged
- MCP SDK transports (via `mcp/`)
- Puppeteer (browser tool), optional native addons

<!-- MANUAL: -->
