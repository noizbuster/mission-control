# Tools Agent Guide

## Overview

`packages/core/src/tools` owns model-callable tool registration and execution for read-only repo tools, `file.patch`, `command.run`, plus the coding-agent capability tools: `glob`, `todowrite`, `webfetch`, the `task` subagent, the `mcp` proxy and namespaced `mcp__*` clients (stdio/remote), the `skill` on-demand loader, and the opt-in `lsp` seam. The MCP client subsystem lives in `mcp/` (see `mcp/AGENTS.md`).

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Tool registry | `tool-registry.ts`, `tool-registry-types.ts` | Schema-bound invocation, version hashing, model output caps. |
| File patch tool | `file-patch*.ts` | Unified diff parsing, workspace guard, dirty checks, approval, diff events. |
| Command run tool | `command-run*.ts` | Structured argv, allowlist, executor, interrupts, timeouts, output caps. |
| Read-only tools | `read-tools*.ts` | Repo read/list/search behavior and path guards. |
| Desktop re-execution | `../desktop-reexecutable-tool-registry.ts`, `../desktop-session-commands.ts`, `../desktop-tool-approval-execution.ts` | One lockstep, argument-reconstructible subset for graph advertisement and approved replay. |
| Tool policy | `command-run-policy.ts`, `tool-defaults-security.test.ts` | Safe default command set and security expectations. |
| MCP clients | `mcp/` (see `mcp/AGENTS.md`) | Stdio + remote transports, config, connection manager, namespaced surfacing, secret redaction. |
| Tool factories | `glob-tool-factory.ts`, `webfetch-tool-factory.ts`, `task-tool-factory.ts`, `skill-tool.ts` | Permission-self-gating factories for the interactive + non-interactive registries. |

## Conventions

- Inputs and outputs must be Zod/schema-bound. Reject malformed arguments before execution.
- Tool advertisements are versioned; stale advertised versions must fail.
- `command.run` accepts structured `command` plus `args`; never accept one shell string.
- `command.run` uses an allowlist, non-interactive execution, timeouts, output byte caps, and redaction.
- `file.patch` requires approval before writes and must preserve workspace containment, symlink escape rejection, patch size limits, dirty tracked-file refusal, and before/after diff events.
- Read-only tools must stay read-only and enforce workspace path guards.
- Desktop graph and approval registries must both use `createDesktopReExecutableToolRegistry`. Keep this subset limited to workspace reads plus effects reconstructible from persisted arguments; preserve the outer approval identity check and each tool's workspace guard.
- Staged previews, jobs, monitors, persistent shell sessions, SSH, checkpoints, plan-exit callbacks, and live LSP operations are session-bound. Do not add them to fresh desktop approval re-execution without shared lifecycle ownership.

## Tests

- Registry behavior: `tool-registry.test.ts`.
- File patch safety: `file-patch.test.ts`, parser/path/apply tests.
- Command execution: `command-run.test.ts`, `command-run-interrupt.test.ts`.
- Read tools: `read-tools.test.ts`.
- Desktop lockstep and approval replay: `../desktop-reexecutable-tool-registry.test.ts`, `../desktop-tool-approval-settlement.test.ts`.
- Security defaults: `tool-defaults-security.test.ts`.

## Anti-Patterns

- Do not execute model-provided shell text through a shell.
- Do not apply patches to dirty tracked files unless the caller explicitly allowed that path.
- Do not follow symlinks out of the workspace.
- Do not return unbounded stdout/stderr to the model or event log.
- Do not skip permission checks for effectful tools.
- Do not describe the desktop subset as full effectful-tool parity or copy session-bound CLI registrations into either desktop site.
