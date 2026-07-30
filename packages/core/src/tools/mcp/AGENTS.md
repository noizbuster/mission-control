<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# mcp

## Purpose

Real MCP (Model Context Protocol) client stack: stdio + remote transports, config discovery/merge, connection lifecycle, namespaced tool surfacing (`mcp__<server>__<tool>`), project-trust gates, and secret redaction.

## Key Files

| File | Description |
|------|-------------|
| `stdio-client.ts` | `StdioMcpClient` over stdio transport; deadline on every call |
| `http-client.ts` | `RemoteMcpClient` (StreamableHTTP + SSE fallback) |
| `base-client.ts` | Shared client base behavior |
| `deadline.ts` | `raceWithDeadline` + `McpDeadline` (default 5000ms) |
| `secret-redaction.ts` | Longest-first deep mask of configured secrets → `[REDACTED]` |
| `config.ts`, `config-*.ts` | Load/merge/write MCP config; profile-aware paths; `${VAR}` allowlist |
| `connection-manager.ts`, `connection-lifecycle.ts` | `connectAll` / scope disconnect / teardown fencing; 50-tool cap |
| `default-client.ts` | Build stdio (workspace cwd) vs remote clients |
| `surfacing.ts`, `surfacing-names.ts` | Registry registration + name sanitization; live trust revalidation |
| `live-authority.ts` | Invocation-time authority helpers |
| `fixtures/stdio-fixture-server.mjs` | Hand-rolled JSON-RPC stdio fixture server |

Parent seam: `../mcp-tool.ts` (`McpClient`, `InProcessMcpClient`).

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `fixtures/` | Stdio fixture server for tests |

## For AI Agents

### Working In This Directory

- Every transport call (`connect`/`listTools`/`callTool`) MUST use `raceWithDeadline` (default 5000ms).
- Server env/header secrets NEVER enter events/logs/output — redact before `ToolResult`.
- Arbitrary MCP output is untrusted DATA (capped, not scrubbed); only configured secrets are masked.
- Connect user-scope + trusted-workspace project servers **eagerly** at session start (AI-SDK bridge snapshots `advertise()` per node-run).
- Resolve project trust before `connectAll()` and before reading/merging `.mcp.json`.
- Launch every local stdio server with `cwd = workspaceRoot` (not launcher `process.cwd()`). Remote has no cwd.
- Re-read canonical trust before every project-scope invocation; non-`trusted` or lookup failure closes project connections and fails non-retryably.
- Child network is category-scoped (`CHILD_NETWORK_ALLOWED_CATEGORIES` in `../../agents/`). ON: librarian/deep/reasoner/oracle/designer/planner. OFF: explore/reviewer/quick.
- Profile-aware config: selected profile candidates only; no silent fallback to base `config.json` when profile set.

### Testing Requirements

- `stdio-client.test.ts`, `http-client.test.ts` (mocked — no real network)
- `secret-redaction.test.ts`, `config.test.ts`
- `surfacing.test.ts`, `surfacing-resilience.test.ts`, `surfacing-names.test.ts`
- `project-trust-gate.test.ts`, `project-trust-revocation.test.ts`, `live-authority-races.test.ts`
- `connection-manager-workspace-cwd.test.ts`
- Use fixture server or mocks only

### Common Patterns

- Graceful degradation on partial connect failures; close-once ownership per scope
- Namespaced tools self-gate permissions + revalidate trust live
- Config writes drop comments; JSONC strip on read; trailing commas unsupported

## Dependencies

### Internal

- `../` tool registry and parent `mcp-tool.ts`
- `../../trust/` — project trust decisions
- `../../agents/child-graph-spawn.ts` — child network matrix
- `@mission-control/protocol` / config loaders as used

### External

- MCP SDK client transports (`StdioClientTransport`, StreamableHTTP/SSE)
- Node child_process for stdio servers

<!-- MANUAL: -->
