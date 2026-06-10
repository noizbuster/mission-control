# Desktop Agent Guide

## Overview

`apps/desktop` owns the React/Vite desktop UI and the Tauri command bridge. Browser-facing code stays in `src`; native command handlers and session-log reading stay in `src-tauri`.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| React bootstrap | `src/main.tsx` | Mounts the desktop shell. |
| Main shell | `src/App.tsx` | UI state, event log, provider controls, session inspector wiring. |
| Composer/write flows | `src/ChatComposer.tsx`, `src/useDesktopWriteActions.ts` | Calls the client abstraction, then reloads projections. |
| Client boundary | `src/lib/agent-client.ts` | Mock and Tauri clients; all Tauri payloads are parsed here. |
| Desktop schemas | `src/lib/desktop-*.ts` | Zod schemas for command receipts and session payloads. |
| Inspector projection | `src/lib/session-inspector.ts` | Timeline, graph, approval, patch, command views. |
| Redaction | `src/lib/redaction.ts`, `src/lib/tool-call-preview.ts` | User-visible secret masking. |
| Tauri command surface | `src-tauri/src/lib.rs` | Registered command names and Rust tests. |
| Session log parsing | `src-tauri/src/session_*.rs`, `src-tauri/src/sessions.rs` | JSONL header, event, sequence, timestamp invariants. |
| Tauri config | `src-tauri/tauri.conf.json` | Product metadata and Vite build hooks. |

## Conventions

- `src` is UI/client-only. It must talk through `DesktopAgentClient`, not directly through native files or runtime internals.
- `src-tauri` owns native command handlers, session-file access, and snapshot parsing only. The desktop shell must not directly mutate workspace files.
- Keep the mock desktop client first-class; it is deliberate scaffold/demo behavior.
- Tauri command names and payload shapes are shared contracts. Update `src/lib/agent-client.ts`, `src/lib/desktop-command-schemas.ts`, `src-tauri/src/lib.rs`, and tests together.
- Parse every native response with Zod before rendering it.
- Redact user-visible event text, approval previews, command output, and credential-like strings.

## Tests

- React behavior tests live beside UI code as `App*.test.tsx`.
- Client boundary tests live in `src/lib/agent-client*.test.ts`.
- Tauri Rust tests live in `src-tauri/src/lib.rs` and `src-tauri/src/session_log_invariant_tests.rs`.
- For session-log or command changes, run both `NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run desktop:test` and `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`.

## Anti-Patterns

- Do not make the UI reach into `packages/core` runtime internals.
- Do not remove corrupt/missing/empty session states; the inspector has tests for all of them.
- Do not use `unwrap`, `expect`, or `panic` in Rust production paths; Cargo lints deny them.
- Do not edit `dist` or `src-tauri/target`.
