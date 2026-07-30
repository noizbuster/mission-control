<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# native

## Purpose

Native integration clients: process sidecar (spawn, handshake, capability negotiation, `runTask`, wire parse) with mock fallback, and `mission-control-natives` Node addon client (grep/glob/fuzzy/summary/ast-grep). Mock/fallback remains part of the scaffold contract while native execution is partial.

## Key Files

| File | Description |
|------|-------------|
| `sidecar-client.ts` | `SidecarClient` / `ProcessSidecarClient` — spawn, handshake, status, runTask |
| `sidecar-wire.ts` | Line normalize, wire response parse, map to agent events |
| `sidecar-errors.ts` | `SidecarProtocolError` |
| `mock-sidecar-client.ts` | `MockSidecarClient` test/fallback double |
| `natives-client.ts` | Natives `.node` addon loader + grep/glob/fuzzy/summary/ast APIs |
| `*.test.ts` | Client, wire, timeout, mock, natives tests |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Protocol versions/capabilities from `@mission-control/protocol` (v2/v3 flags on process client).
- Default timeouts matter (`timeoutMs`, dedicated timeout tests) — hung sidecar must not block forever.
- Production still uses TS core for `file.patch` / `command.run` by default; sidecar negotiates `task.run` (and optional shell/pty/iso caps).
- Do not remove mock sidecar while native path is partial.
- Natives path: env override for `.node` artifact takes priority over resolved candidates.
- Parse all wire payloads defensively; map through `sidecar-wire` helpers.

### Testing Requirements

- `sidecar-client.test.ts`, `process-sidecar-client.test.ts`, `sidecar-timeout.test.ts`, `mock-sidecar-client.test.ts`, `natives-client.test.ts`
- No dependency on a live compiled sidecar binary in unit tests — use mock

### Common Patterns

- start → handshake/negotiate → runTask → stop
- Stream decode may reuse `../providers/stream-decoder`

## Dependencies

### Internal

- `@mission-control/protocol` — sidecar wire types, capabilities, task I/O
- `../providers/stream-decoder.ts`
- Agent runtime selects process vs mock client

### External

- Node `child_process` for process sidecar
- Optional `mission-control-natives` native addon

<!-- MANUAL: -->
