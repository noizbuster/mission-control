<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# protocol

## Purpose

`@mission-control/protocol` owns the shared Zod schemas and TypeScript types for values that cross packages, apps, CLI output, desktop payloads, provider boundaries, session data, and the Rust sidecar protocol. If data crosses a boundary, define or update the schema here before consumers use it.

## Key Files

| File | Description |
|------|-------------|
| `package.json` | `@mission-control/protocol`; sole runtime dep `zod` |
| `project.json` | Nx project `protocol`: build / typecheck / test |
| `tsconfig.json` | Package TS config |
| `vite.config.ts` | Library Vite build |
| `src/` | All schemas and public export barrels (see `src/AGENTS.md`) |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | Schema modules + public barrels (see `src/AGENTS.md`) |

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Public exports | `src/index.ts` | Re-exports foundation / runtime / session barrels only |
| Agent events and sessions | `src/schema.ts`, `src/schema-exports.ts` | Event types, envelopes, logs, sessions, snapshots, replay cursors |
| ABG schemas | `src/abg*.ts` | Graph specs, node/rule/policy schemas, signals, snapshots |
| Approvals and permissions | `src/approval.ts`, `src/permission-profile.ts` | Approval lifecycle; workspace `PermissionRule` / `PermissionKind` |
| Workflow policy rules | `src/permission-rule.ts` | `PolicyEffectRuleSchema` (action/resource/effect) — **not** workspace permissions |
| Provider auth/catalog | `src/provider-auth.ts` | Credentials, catalog status, auth file shapes |
| Provider events/tools | `src/provider-events.ts` | Provider messages, tool definitions/results, redaction metadata |
| Commands and diffs | `src/command-events.ts`, `src/diff-events.ts` | Command lifecycle and file diff event metadata |
| Sidecar protocol | `src/sidecar.ts` | Protocol version, capability, status, handshake/task wire schemas |
| MCP config schema | `src/mcp-config.ts` | Local/remote MCP entries, `MissionControlConfigSchema`, `.mcp.json` project shape. Profile files reuse the same schema (filename only differs) |
| Workflow / mode / category | `src/workflow.ts`, `src/mode.ts`, `src/category.ts`, `src/delivery.ts` | `WorkflowSpecSchema`, mode overlays, task categories, steer/queue delivery |
| Agents | `src/agent.ts` | `AgentDefinitionSchema` frontmatter contract |
| Mission/Run | `src/mission-run.ts` | Mission + Run lifecycle schemas (SQL-authoritative runs) |
| Session control | `src/session-lifecycle.ts`, `src/session-stop.ts`, `src/session-owner-control.ts`, `src/session-tree.ts` | Status, stop scopes, owner-control wire, tree/archive |
| Internal URL schemes | `src/scheme.ts` | `pr`/`issue`/`agent`/`skill`/`rule`/`conflict` parse + schemas |
| Transcript/run metadata | `src/transcript.ts`, `src/run-coordinator.ts` | Prompt delivery and run command/state events |

## For AI Agents

### Working In This Directory
- Constants backing Zod enums are part of the public contract. Update tests and exports when changing them.
- Keep schemas strict where boundary data must reject unknown fields.
- Preserve event-log invariants in `AgentEventLogSchema`: strictly increasing sequence numbers and unique event IDs.
- Preserve ABG graph invariants: unique node IDs, valid entry node, valid edge endpoints, valid rule references.
- Keep public exports named; wire new symbols through the appropriate `public-*-exports.ts` barrel (or `misc-exports` / domain file already re-exported).
- **Two permission systems:** workspace `PermissionRuleSchema` (`permission-profile.ts`) vs workflow `PolicyEffectRuleSchema` (`permission-rule.ts`). Do not collapse them.
- Sidecar version/capability changes require lockstep updates in `native/sidecar` and `packages/core/src/native`.

### Testing Requirements
- Schema coverage lives beside source as `src/*.test.ts`.
- Public export coverage also lives in root `tests/protocol-export.test.ts`.
- Sidecar changes: protocol tests + Rust sidecar tests.
- Event/session changes: protocol tests + core replay/session tests.
- Focused: `pnpm exec vitest run packages/protocol/src/<file>.test.ts`
- Package: `NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run protocol:test`

### Common Patterns
- `z.object({...}).strict()` for boundary objects
- Paired `FOO_VALUES` const array + `FooSchema = z.enum(FOO_VALUES)` + exported type
- Colocated `*.test.ts` round-trip parse/reject cases

## Dependencies

### Internal
- Consumed by `@mission-control/config`, `@mission-control/core`, `apps/*`, root contract tests
- Wire twin: `native/sidecar` (`SIDECAR_PROTOCOL_VERSION` and handshake schemas)

### External
- `zod` ^4.x

## Anti-Patterns

- Do not duplicate protocol types in apps or core instead of importing them.
- Do not loosen schemas to make malformed fixtures pass.
- Do not change sidecar protocol version/capabilities without updating `native/sidecar` and core native client behavior.
- Do not treat deprecated catalog statuses as active behavior without explicit migration coverage.
- Do not edit `dist`.

<!-- MANUAL: -->
