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
| Config loader | `config.ts` | `config.json` mcp section + trust-gated `.mcp.json` runtime merge; `${VAR}` allowlist (user-config-only); `expandedSecrets` collection. `loadRuntimeMcpConfig` reads project config only for the canonical `trusted` decision, while management reads retain scope visibility. Profile-aware when `profileName` is set: `loadResolvedMcpConfig` reads only the selected profile candidate (`mission-control.<profile>.jsonc|.json`, then `config.<profile>.jsonc|.json`; first existing wins) and never falls back to base `config.json`. `resolveUserConfigPath` throws profile-not-found listing candidates; `resolveUserConfigPathForWrite` creates `mission-control.<profile>.jsonc` when none exists (writes drop comments). JSONC comments stripped; trailing commas unsupported. |
| Connection manager | `connection-manager.ts` | `McpConnectionManager.connectAll()/disconnectScope()/disconnectAll()`; one-shot connect, teardown fencing, scope-aware close-once ownership, graceful degradation, 50-tool cap. |
| Default client selection | `default-client.ts` | Creates local stdio clients in the selected workspace and remote HTTP clients without cwd semantics. |
| Namespaced surfacing | `surfacing.ts` | `registerNamespacedMcpTools` → `mcp__<server>__<tool>` merged into the registry; graph-path permission self-gating plus live project-trust revalidation. |
| Test fixture | `fixtures/stdio-fixture-server.mjs` | Hand-rolled JSON-RPC 2.0 stdio server (modes: normal/cwd/hung/crash/metadata-secret). |

## Conventions

- Every transport call (`connect`/`listTools`/`callTool`) MUST go through `raceWithDeadline` (default 5000ms).
- Server `env`/header secrets are NEVER serialized into events/logs/output — redacted via `createSecretRedactor` before `ToolResult`.
- Arbitrary MCP output is untrusted DATA (capped, not scrubbed); only configured env/header secrets are masked.
- Connect user-scope and trusted-workspace project servers EAGERLY at session start (the AI-SDK bridge snapshots `advertise()` per node-run — lazy connect = turn-1 tool blindness). Resolve project trust before `connectAll()` and before reading or merging `.mcp.json`.
- Config scope controls provenance, project trust, and name precedence, not process location. Launch every local stdio server, whether user or project scope, with `cwd` set to the selected `workspaceRoot`; never use the launcher `process.cwd()`. Remote servers have no cwd.
- Re-read canonical trust before every project-scope MCP invocation. Any non-`trusted` result or lookup failure must close and remove project connections before returning a non-retryable failure; user-scope connections and invocation-time network approval remain independent.
- **Child network is category-scoped, not universally denied.** `network` stays in `CHILD_HARD_DROPPED_CAPABILITY_KINDS` (`../../agents/child-graph-spawn.ts`). The filter-time exception is `CHILD_NETWORK_ALLOWED_CATEGORIES` via `allowNetworkCapability`:
  - **ON** (may retain parent `webfetch` / `web_search` / `mcp__*`): `librarian`, `deep`, `reasoner`, `oracle`, `designer`, `planner`
  - **OFF** (network hard-dropped; no webfetch/mcp on child): `explore`, `reviewer`, `quick`
  - Webfetch / namespaced MCP claims on children apply only to ON paths. Prefer routing external lookup via `librarian` (or another ON category when chosen).
- Research workflow parents (`research-explore`, planner `explore`/`research`) declare parent capabilities `read+subagent+network` so they can advertise network tools and `task()`; that is separate from the child matrix above. See `../../behavior/AGENTS.md` and `../task/AGENTS.md`.

## Tests

- Transport: `stdio-client.test.ts` (7), `http-client.test.ts` (11, mocked — no real network).
- Redaction: `secret-redaction.test.ts` (6).
- Config: `config.test.ts` (11).
- Surfacing: `surfacing.test.ts` (5), `surfacing-resilience.test.ts` (4), `project-trust-gate.test.ts` (6), `project-trust-revocation.test.ts` (6), `live-authority-races.test.ts` (3).

## Anti-Patterns

- Do NOT make real network calls in tests — use mocked transports or the loopback fixture server.
- Do NOT leave a transport call without a deadline — a hung server must reject at the boundary.
- Do NOT register MCP tools into child/subagent registries for OFF categories; network remains hard-dropped unless the child category/agent is in `CHILD_NETWORK_ALLOWED_CATEGORIES`. Do not claim all children have network.
- Do NOT bypass the `${VAR}` allowlist — project configs cannot extend it.
