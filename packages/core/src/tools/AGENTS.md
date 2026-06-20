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

## Tests

- Registry behavior: `tool-registry.test.ts`.
- File patch safety: `file-patch.test.ts`, parser/path/apply tests.
- Command execution: `command-run.test.ts`, `command-run-interrupt.test.ts`.
- Read tools: `read-tools.test.ts`.
- Security defaults: `tool-defaults-security.test.ts`.

## Anti-Patterns

- Do not execute model-provided shell text through a shell.
- Do not apply patches to dirty tracked files unless the caller explicitly allowed that path.
- Do not follow symlinks out of the workspace.
- Do not return unbounded stdout/stderr to the model or event log.
- Do not skip permission checks for effectful tools.
