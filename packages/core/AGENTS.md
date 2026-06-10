# Core Agent Guide

## Overview

`packages/core` owns runtime behavior: event logs, session admission/replay, permissions, provider turns, approval-gated tools, native sidecar fallback, desktop command services, and bounded ABG/action-graph scaffolding.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Public exports | `src/index.ts` | Export new public runtime APIs here intentionally. |
| Runtime facade | `src/agent-runtime.ts` | Session lifecycle, event emission, sidecar selection, provider/graph task dispatch. |
| Run coordination | `src/runtime/` | Prompt admission, wake/run/resume/interrupt, scheduler. |
| Provider turns | `src/providers/` | Adapters, retries, timeouts, redaction, OpenAI Responses mapping. |
| Native sidecar | `src/native/` | Process spawn, handshake, status, timeout, mock fallback. |
| Durable logs | `src/memory/` | JSONL event store, data-dir resolution, projections. |
| Replay | `src/session-replay.ts`, `src/session-*.ts` | Branch, approval, tool outcome, prompt admission projections. |
| Tools | `src/tools/` | Tool registry, read-only repo tools, `file.patch`, `command.run`. |
| ABG/action graphs | `src/behavior/` | Authorable graph validation, node registry, coordination, projection. |
| Desktop commands | `src/desktop-session-commands.ts`, `src/desktop-tool-approvals.ts` | Core service behind future desktop write paths. |

## Invariants

- Event streams are append-only. Derive projections from events instead of mutating hidden state.
- Values crossing app/package/sidecar boundaries must be parsed with `@mission-control/protocol` schemas.
- Default permissions stay conservative; `createDefaultPermissionDecision` denies.
- Mock/fallback sidecar behavior is part of the scaffold contract. Do not remove it while native execution remains partial.
- `file.patch` and `command.run` stay on the TypeScript core path by default; the Rust sidecar currently negotiates `task.run` only.
- Do not implement unrestricted file editing, persistent vector memory, full scheduler orchestration, or a full ABG engine unless explicitly requested.
- Keep public exports named and typed. Avoid `any`, `as any`, `as unknown`, suppression comments, and non-null assertions.

## Tests

- Runtime behavior: `src/agent-runtime*.test.ts`, `src/runtime/*.test.ts`.
- Sidecar fallback/timeouts: `src/native/*.test.ts`.
- Durable sessions and replay: `src/memory/*.test.ts`, `src/session-*.test.ts`.
- Tool policy and output: `src/tools/*.test.ts`.
- Graph behavior: `src/behavior/*.test.ts`.
- Run focused tests with `pnpm exec vitest run packages/core/src/<file>.test.ts`; broaden to `NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run core:test` when shared behavior changes.

## Child Guidance

- `src/behavior/AGENTS.md` governs ABG/action-graph code.
- `src/providers/AGENTS.md` governs provider adapters, credentials, and redaction.
- `src/tools/AGENTS.md` governs tool registration, `file.patch`, `command.run`, and repo-read tools.

## Anti-Patterns

- Do not write around the durable JSONL store by hand.
- Do not emit protocol-shaped objects without schema validation when crossing a boundary.
- Do not treat provider catalog entries as implemented adapters.
- Do not edit `dist`.
