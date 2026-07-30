<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# src

## Purpose

Flat schema module set for `@mission-control/protocol`. `index.ts` is a three-line barrel over public foundation/runtime/session export modules; domain files hold Zod contracts and paired TypeScript types.

## Key Files

### Public barrels

| File | Description |
|------|-------------|
| `index.ts` | `export *` from the three public barrels only |
| `public-foundation-exports.ts` | ABG, workflow foundations, agents, MCP, permissions, plugins, pricing, memory, media, ssh, dap, scheme, … |
| `public-runtime-exports.ts` | Provider stream/request, redaction, errors, tools/results, auth catalog surfaces |
| `public-session-exports.ts` | Session finalize, owner-control, stop, lifecycle, tree/archive |
| `schema-exports.ts` | Re-export cluster for core event/session/approval schema surface |
| `misc-exports.ts` | Command events, permission-profile, and other smaller public clusters |

### Core domain schemas

| File | Description |
|------|-------------|
| `schema.ts` | Agent events, envelopes, logs, sessions, snapshots, replay cursors |
| `abg.ts` | `AbgGraphSpecSchema` and graph/node/edge/policy building blocks |
| `abg-constants.ts` | ABG status/kind/signal const enums |
| `abg-signal.ts` / `abg-snapshot.ts` / `abg-overlay-prefs.ts` | Signal, snapshot, overlay preference contracts |
| `approval.ts` | Approval lifecycle states, subjects, records |
| `permission-profile.ts` | Workspace `PERMISSION_KINDS`, `PermissionRuleSchema` |
| `permission-rule.ts` | Workflow `PolicyEffectRuleSchema` (action/resource/effect) |
| `provider-auth.ts` | Auth methods, catalog entries, auth-file shapes |
| `provider-events.ts` | Provider messages, tool defs/results, stream chunks, redaction metadata |
| `command-events.ts` / `diff-events.ts` | Command run + file diff event metadata |
| `sidecar.ts` | `SIDECAR_PROTOCOL_VERSION`, handshake, capability, task wire |
| `mcp-config.ts` | MCP server entries, mission-control config, project `.mcp.json` |
| `workflow.ts` / `mode.ts` / `category.ts` / `delivery.ts` | WorkflowSpec, Mode overlay, task Category, steer/queue delivery |
| `agent.ts` | `AgentDefinitionSchema` (frontmatter + body contract) |
| `mission-run.ts` | Mission + Run status/transition schemas |
| `session-lifecycle.ts` / `session-stop.ts` / `session-owner-control.ts` / `session-tree.ts` / `session-finalize-event.ts` | Session control plane |
| `run-coordinator.ts` / `transcript.ts` | Run command/state + transcript delivery metadata |
| `scheme.ts` | Internal `://` scheme names + URL parse schemas |
| `plugin.ts` | `PluginManifestSchema` + `provides` map |
| `memory.ts` | Memory backend catalog ids (`off`/`local`/`mnemopi`/`hindsight`) |
| `media-tool.ts` | `generate_image` / `tts` artifact-path result contracts |
| `ssh-config.ts` | Config-gated SSH host credential surface |
| `pricing.ts` | Pricing table + budget config |
| `dap.ts` | DAP adapter registry catalog (declared, mostly unsupported) |
| `event-primitives.ts` / `tool-result-primitives.ts` / `messages.ts` / `events.ts` / `commands.ts` | Shared primitive schemas / thin re-export shims |
| `tui-provider-data.ts` / `tui-plugin-data.ts` | TUI-facing provider/plugin DTO schemas |
| `graph-checkpoint.ts` | Graph checkpoint wire schema |

Tests are colocated as `*.test.ts` (and a few `*-test-support.ts` helpers for session-stop contracts).

## Subdirectories

None — all modules are flat files in this directory.

## For AI Agents

### Working In This Directory
- Add schemas in a focused domain file; export through the matching `public-*-exports.ts` (or existing domain re-export path) so `index.ts` stays untouched.
- Prefer `.strict()` on objects that cross CLI/desktop/sidecar/session boundaries.
- When extending enums, update the `as const` array, Zod enum, tests, and any Rust twin (sidecar) in the same change set.
- `PolicyEffectRule` vs `PermissionRule`: pick by layer (workflow policy-gate vs workspace store).
- Profile config filenames are a core/CLI concern; schema remains `MissionControlConfigSchema`.

### Testing Requirements
- Every new public schema needs parse success + reject-unknown / reject-invalid cases.
- Root `tests/protocol-export.test.ts` may need updates when export surface changes.
- Session-stop contract helpers: `session-stop-contract-test-support.ts` shared with multi-file stop tests.

### Common Patterns
- No runtime side effects; pure schema modules only
- `z.infer<typeof FooSchema>` for exported types
- Discriminated unions for transport variants (e.g. MCP local vs remote)

## Dependencies

### Internal
- Parent package docs: `../AGENTS.md`
- Consumers: config, core, apps, native sidecar (conceptual wire twin)

### External
- `zod`

<!-- MANUAL: -->
