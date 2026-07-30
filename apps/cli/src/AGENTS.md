<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# src

## Purpose

CLI TypeScript source root: executable entry, top-level arg parsers, auth store shim, crash guard, and the two major subtrees `commands/` (runtime orchestration) and `ui/` (noninteractive renderers).

## Key Files

| File | Description |
|------|-------------|
| `index.tsx` | Executable entry: help/version, routes to run/auth/session/mcp/models/agents |
| `index.test.ts` | Entrypoint routing tests |
| `cli-version.ts` | `getVersion()` — safe import without running `runCli()` |
| `cli-command-result.ts` | Shared CLI result type |
| `args.ts` | Top-level flags/modes; default mode `'tui'`; `--profile` parse |
| `args.test.ts` | Arg union/mode tests |
| `run-args.ts` | `--json`/`--jsonl`, provider/model, native, graph, workspace, session, engine |
| `auth-args.ts` | Auth subcommand args → `commands/auth*.ts` |
| `session-args.ts` | Session subcommand args → `commands/session.ts` |
| `mcp-args.ts` | MCP list/test/add/remove args + profile threading |
| `auth-store.ts` | Thin auth-store re-export/shim used by CLI |
| `provider-catalog-lookup.ts` | Catalog lookup helper for provider/model resolution |
| `provider-credential-resolver.ts` | Credential resolution for configured providers |
| `crash-guard.ts` | Process crash/error guard for CLI runs |
| `assert-unreachable.ts` | Exhaustiveness helper |
| `app.tsx` | Legacy/stub residual (45B); interactive App lives in `apps/tui` |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `commands/` | All CLI command modules and interactive loop (see `commands/AGENTS.md`) |
| `ui/` | Noninteractive plain/JSON/JSONL renderers (see `ui/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Entry must stay free of static OpenTUI imports.
- Parse modules (`*-args.ts`) must not perform I/O beyond reading argv.
- Prefer adding command logic under `commands/`, renderer logic under `ui/`.
- `cli-entrypoint-import-cycle.test.ts` guards against import cycles that would re-enter `runCli()`.

### Testing Requirements
- `args.test.ts`, `index.test.ts`, `crash-guard.test.ts`, credential/auth-store tests at this level.
- Command and renderer tests live in their subdirs.

### Common Patterns
- Named exports; `import type` for type-only.
- Exit codes and help strings are contracts — update tests with string changes.

## Dependencies

### Internal
- `commands/` — orchestration
- `ui/` — noninteractive output
- `apps/tui` — lazy only from commands interactive path
- `packages/core`, `packages/protocol`, `packages/config`

### External
- None beyond package deps

<!-- MANUAL: -->
