# MCP Tools Agent Guide

## Overview

`packages/core/src/tools/mcp` owns the real MCP (Model Context Protocol) client: stdio + remote transports, config discovery, connection lifecycle, namespaced tool surfacing, and secret redaction.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| McpClient seam | `mcp-tool.ts` (parent) | `McpClient` interface (`listTools`/`callTool`), `InProcessMcpClient` for tests. |
| Stdio transport | `stdio-client.ts` | `StdioMcpClient` over `StdioClientTransport`; 5s bounded deadline on every call. |
| Remote transport | `http-client.ts` | `RemoteMcpClient` (StreamableHTTP + SSE fallback); one justified `as Transport` cast (SDK exactOptionalPropertyTypes defect). |
| Shared deadline | `deadline.ts` | `raceWithDeadline(label, ms, run)` + `McpDeadline`; shared by both clients. |
| Secret redaction | `secret-redaction.ts` | `createSecretRedactor(secrets)` longest-first deep-recursive mask → `[REDACTED]`. |
| Config loader | `config.ts` | `config.json` mcp section + `.mcp.json` merge; `${VAR}` allowlist (user-config-only); `expandedSecrets` collection. |
| Connection manager | `connection-manager.ts` | `McpConnectionManager.connectAll()/disconnectAll()`; eager connect, graceful degradation, 50-tool cap. |
| Namespaced surfacing | `surfacing.ts` | `registerNamespacedMcpTools` → `mcp__<server>__<tool>` merged into the registry; graph-path self-gating. |
| Test fixture | `fixtures/stdio-fixture-server.mjs` | Hand-rolled JSON-RPC 2.0 stdio server (modes: normal/hung/crash). |

## Conventions

- Every transport call (`connect`/`listTools`/`callTool`) MUST go through `raceWithDeadline` (default 5000ms).
- Server `env`/header secrets are NEVER serialized into events/logs/output — redacted via `createSecretRedactor` before `ToolResult`.
- Arbitrary MCP output is untrusted DATA (capped, not scrubbed); only configured env/header secrets are masked.
- Connect EAGERLY at session start (the AI-SDK bridge snapshots `advertise()` per node-run — lazy connect = turn-1 tool blindness).
- `network` capability tools are dropped from child registries (child-policy blocklist, todo 3).

## Tests

- Transport: `stdio-client.test.ts` (7), `http-client.test.ts` (11, mocked — no real network).
- Redaction: `secret-redaction.test.ts` (6).
- Config: `config.test.ts` (11).
- Surfacing: `surfacing.test.ts` (15, incl. projection + hung-server graceful skip).

## Anti-Patterns

- Do NOT make real network calls in tests — use mocked transports or the loopback fixture server.
- Do NOT leave a transport call without a deadline — a hung server must reject at the boundary.
- Do NOT register MCP tools into child/subagent registries (`network` capability is not child-safe).
- Do NOT bypass the `${VAR}` allowlist — project configs cannot extend it.
