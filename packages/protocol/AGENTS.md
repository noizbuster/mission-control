# Protocol Agent Guide

## Overview

`packages/protocol` owns the shared Zod schemas and TypeScript types for values that cross packages, apps, CLI output, desktop payloads, provider boundaries, session logs, and the Rust sidecar protocol.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Public exports | `src/index.ts` | Package export surface; keep it intentional. |
| Agent events and sessions | `src/schema.ts` | Event types, envelopes, logs, sessions, snapshots, replay cursors. |
| ABG schemas | `src/abg*.ts` | Graph specs, node/rule/policy schemas, signals, snapshots. |
| Approvals and permissions | `src/approval.ts`, `src/schema.ts` | Approval lifecycle and permission decision contracts. |
| Provider auth/catalog | `src/provider-auth.ts` | Credentials, catalog status, auth file shapes. |
| Provider events/tools | `src/provider-events.ts` | Provider messages, tool definitions/results, redaction metadata. |
| Commands and diffs | `src/command-events.ts`, `src/diff-events.ts` | Command lifecycle and file diff event metadata. |
| Sidecar protocol | `src/sidecar.ts` | Protocol version, capability, status, handshake/task wire schemas. |
| MCP config schema | `src/mcp-config.ts` | `McpConfigEntrySchema` (local/remote discriminated union), `MissionControlConfigSchema` (mcp + mcp_env_allowlist + lsp placeholder), `McpProjectConfigSchema` (.mcp.json mcpServers). |
| Permission kinds | `src/permission-profile.ts` | `PERMISSION_KINDS` union: read/edit/write/patch/bash/network/subagent. Strict schemas. |
| Transcript/run metadata | `src/transcript.ts`, `src/run-coordinator.ts` | Prompt delivery and run command/state events. |

## Conventions

- If data crosses package, CLI, desktop, provider, session-log, or sidecar boundaries, define or update the schema here before consumers use it.
- Constants backing Zod enums are part of the public contract. Update tests and exports when changing them.
- Keep schemas strict where boundary data must reject unknown fields.
- Preserve event-log invariants in `AgentEventLogSchema`: strictly increasing sequence numbers and unique event IDs.
- Preserve ABG graph invariants: unique node IDs, valid entry node, valid edge endpoints, valid rule references.
- Keep public exports named; do not expose internal helper-only types by accident.

## Tests

- Schema coverage lives beside source as `src/*.test.ts`.
- Public export coverage also lives in root `tests/protocol-export.test.ts`.
- For sidecar changes, update both protocol tests and Rust sidecar tests.
- For event/session changes, update protocol tests plus core replay/session tests.

## Anti-Patterns

- Do not duplicate protocol types in apps or core instead of importing them.
- Do not loosen schemas to make malformed fixtures pass.
- Do not change sidecar protocol version/capabilities without updating `native/sidecar` and core native client behavior.
- Do not treat deprecated catalog statuses as active behavior without explicit migration coverage.
