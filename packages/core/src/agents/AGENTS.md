<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# agents

## Purpose

Agent discovery, declaration parsing, live session registry, child-agent lifecycle, model resolution, spawn policy, and the concrete runtime that bridges full-parity `task()` to real agent execution. Discovery scans four builtin scopes (project `.mctrl/agents/`, user `<config>/agents/`, plugin `additionalDirs`, bundled templates) plus nine cross-harness importers. Builtin loader priority 100; cross-harness priority 50. First-wins by name.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Public barrel: discovery, registry, lifecycle, task runtime, recursion policy |
| `agent-loader.ts` | `discoverAgents` — 4-scope builtin + 9 cross-harness via `CapabilityRegistry` |
| `agent-parser.ts` | `parseAgentFile` — YAML frontmatter + body → validated `AgentDefinition` |
| `agent-registry.ts` | `AgentIndex` — in-memory name-keyed map; first-wins `register` |
| `runtime-registry.ts` | `RuntimeAgentRegistry` — main + subagents/advisors by stable id |
| `lifecycle-manager.ts` | `AgentLifecycleManager` — idle/park/revive TTL cycle (default 7 min) |
| `model-roles.ts` | Ten roles: `default`, `smol`, `slow`, `vision`, `plan`, `designer`, `commit`, `title`, `task`, `advisor` |
| `model-resolver.ts` | `resolveAgentModel` — override → agent.model → parent → session default |
| `task-tool-runtime.ts` | `ConcreteTaskToolRuntime` — child resolve + spawn bridge |
| `task-tool-runtime-authority.ts` | `prepareChildSpawnAuthority` / `buildChildToolSurface` |
| `task-tool-runtime-foreground.ts` | Foreground child execution path |
| `task-tool-runtime-background.ts` | Background job execution path |
| `task-tool-runtime-control.ts` | Attachment, listeners, settlement control plane |
| `async-job-manager.ts` | `AsyncJobManager` — semaphore (default 4) + cooperative cancel |
| `spawn-policy.ts` | `canSpawn` — self-recursion, `MCTRL_BLOCKED_AGENT`, parent `spawns` allowlist |
| `approval-tier.ts` | Tool tier (`read`/`write`/`exec`) × approval mode resolver |
| `recursion-policy.ts` | `PRODUCTION_MAX_TASK_DEPTH=3`; compat `DEFAULT_MAX_RECURSION_DEPTH=2` |
| `child-graph-spawn.ts` | `CHILD_HARD_DROPPED_CAPABILITY_KINDS`, `CHILD_NETWORK_ALLOWED_CATEGORIES` |
| `child-tool-permissions.ts` | Category + path-policy invocation checks for child tools |
| `child-tool-resources.ts` | Child resource scoping helpers |
| `path-policy-derive.ts` | `deriveChildPathPolicies` — parent denies override child allows |
| `spawn-prompt-builder.ts` | `buildChildSystemPrompt` — base + role + body + parent context layers |
| `runaway-guard.ts` | Soft steer + hard abort on assistant `message_end` budgets |
| `stall-detection.ts` | `findStalledTargets` — silent-duration stall scan |
| `job-persistence.ts` | Atomic JSON job files under `<jobsDir>/<jobId>.json` |
| `job-recovery.ts` | Crash reconcile: active → cancelled + salvage; no auto-reexec |
| `agent-job-sql-mirror.ts` | SQL mirror for background job handles/lifecycle |
| `sql-task-runtime-services.ts` | `createSqlTaskRuntimeServices` wiring |
| `iso-client.ts` | Isolation client seam for child runs |
| `child-activity-touch.ts` | Activity signals for child host callbacks |
| `legacy-compat.ts` | Legacy agent shape shims |
| `registry.ts` / `sub-agent.ts` | **Deprecated** scaffold — use `AgentIndex` / `AgentDefinition` |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `bundled/` | Generated `*.md.ts` templates + barrel (see `bundled/AGENTS.md`) |
| `bundled-src/` | Editable source `.md` for bundled agents (see `bundled-src-guide.md`) |
| `capability/` | `CapabilityRegistry` priority provider registry (see `capability/AGENTS.md`) |
| `providers/` | Nine cross-harness agent importers (see `providers/AGENTS.md`) |

## For AI Agents

### Working In This Directory

- Agent declarations = markdown + YAML frontmatter (`name`, `description`, `model`, `tools`, `pathPolicies`, `spawns`, `tier`, `role`, `output`); body → `systemPrompt`.
- `parseAgentFile` never returns partial agents — fully validated or throw `AgentParseError`.
- `AGENTS.md` is documentation, not a declaration — must never be discovered as an agent.
- Edit `bundled-src/*.md` then run `scripts/generate-bundled-agents.mjs`; never hand-edit `bundled/*.md.ts`.
- Child authority layers: parent `task()` gate → cloned approval callbacks → category + pathPolicies → structural filter (`task`/`job` depth-gated; hard-drop `workflow`/`team`; category-scoped `network`).
- `AgentDefinition.recursion` is compatibility metadata only — cannot raise `PRODUCTION_MAX_TASK_DEPTH`.
- Fingerprint includes `taskDepth` + max depth; resume requires match.
- `yield` is the child result contract; every child surface gets it via `buildChildToolSurface`.
- Path `PolicyEffectRule` (action/resource/effect) ≠ workspace `PermissionRule` — two systems by design.

### Testing Requirements

- Parser/loader/index: `agent-parser.test.ts`, `agent-loader.test.ts`, `agent-registry.test.ts`
- Lifecycle/registry: `runtime-registry.test.ts`, `lifecycle-manager.test.ts`
- Model: `model-roles.test.ts`, `model-resolver.test.ts`, `model-resolver-precedence.test.ts`
- Task runtime: `task-tool-runtime*.test.ts` (authority, foreground, background, control, permissions, cancellation)
- Jobs: `async-job-manager*.test.ts`, `job-persistence.test.ts`, `job-recovery.test.ts`, `agent-job-sql-mirror*.test.ts`
- Policy: `spawn-policy.test.ts`, `approval-tier.test.ts`, `recursion-policy.test.ts`, `child-network-allowlist.test.ts`, `child-tool-surface-gates.test.ts`
- Focused: `pnpm exec vitest run packages/core/src/agents/<file>.test.ts`

### Common Patterns

- **Nested depth:** spawn while `taskDepth < 3`; depth 3 leaf omits `task`/`job` and hard-drops `subagent`.
- **Child network ON:** `architect`, `librarian`, `deep`, `reasoner`, `oracle`, `designer`, `planner`. **OFF:** `explore`, `reviewer`, `quick`.
- **Spawn allowlist:** `undefined`/`[]` deny all; `'*'` allow all; array = explicit names.
- Exact `mctrl/task` inherits parent/session model.
- Job persistence = atomic temp-then-rename (boulder-store convention). Recovery never auto-reexecutes.
- Registries hold state only; lifecycle owned by `AgentLifecycleManager`.

## Dependencies

### Internal

- `@mission-control/protocol` — `AgentDefinition`, schemas
- `../behavior/` — coding-agent graph/registry for child spawn
- `../tools/` — tool registry, task/yield tools, ask-user
- `../runtime/` — session control cancellation/epoch
- `../providers/` — observability redactor
- `../persistence/` — boulder conventions (job files)
- `../util/` — `errorToString`

### External

- `zod` — schema validation via protocol
- `yaml` — frontmatter parse (via agent-parser path)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
