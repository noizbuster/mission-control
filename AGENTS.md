# Mission Control Agent Guide

**Generated:** 2026-06-20T00:30:00+09:00
**Commit:** 5b04ce5
**Branch:** master

## Overview

`mission-control` is a staged control surface for observable LLM-agent workflows. It implements a bounded coding-agent MVP over the original scaffold: provider turns, durable JSONL sessions, approval-gated tools, replay projections, graph coordination, CLI chat, desktop inspection, and a versioned sidecar handshake. It still does not implement the full ABG engine.

Product names:

- CLI command: `mctrl`
- Desktop app: `mission-control`
- Native helper binary: `mission-control-sidecar`

Design references:

- `ABG.md`: root design reference.
- `docs/ABG.md`: mirror of root `ABG.md`.
- `docs/ABG.ko.md`: Korean ABG document.
- `README.md`: scaffold architecture, distribution story, and extension points.

## Structure

```text
mission-control/
|-- apps/cli/                 # mctrl CLI
|-- apps/desktop/             # React/Vite UI plus Tauri shell
|-- packages/protocol/        # shared Zod schemas and exported protocol types
|-- packages/core/            # runtime, sessions, providers, tools, sidecar fallback, ABG scaffolding, MCP clients, skills
|-- packages/config/          # product constants and vendored model catalog snapshot
|-- native/sidecar/           # Rust JSON Lines sidecar binary
|-- scripts/                  # install, packaging, catalog sync helpers, smoke tests
|-- tests/                    # root workspace, README, workflow, integration, contract tests
|-- examples/abg/             # valid and intentionally invalid authorable graph fixtures
`-- .omo/plans/               # work plans and execution state (gitignored agent state)
```

Scoped guidance:

- `apps/cli/AGENTS.md`
- `apps/desktop/AGENTS.md`
- `packages/protocol/AGENTS.md`
- `packages/core/AGENTS.md`
- `packages/core/src/behavior/AGENTS.md`
- `packages/core/src/context/AGENTS.md`
- `packages/core/src/providers/AGENTS.md`
- `packages/core/src/runtime/AGENTS.md`
- `packages/core/src/tools/AGENTS.md`
- `packages/core/src/tools/mcp/AGENTS.md`
- `packages/core/src/agents/AGENTS.md`

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| CLI entry/help/version | `apps/cli/src/index.tsx` | `apps/cli/package.json` maps `mctrl` to `./dist/index.js`. |
| CLI command flow | `apps/cli/src/commands/run-agent.ts` | Chat, JSON/JSONL, graph, provider, sidecar selection. |
| CLI output | `apps/cli/src/ui/renderers.ts` | Plain, TUI (buffered summary), and JSON renderer contracts. |
| Interactive chat opentui bridge | `apps/cli/src/commands/opentui-chat-bridge.tsx` | opentui React tree (`@opentui/react` over a node:ffi-loaded Zig core) ↔ imperative chat loop bridge. |
| Desktop entry/UI | `apps/desktop/src/main.tsx`, `apps/desktop/src/App.tsx` | Browser-facing shell. |
| Desktop client boundary | `apps/desktop/src/lib/agent-client.ts` | Mock and Tauri clients, Zod response parsing. |
| Tauri native shell | `apps/desktop/src-tauri` | Command bridge and Rust session-log parsing. |
| Protocol exports | `packages/protocol/src/index.ts` | Public schema/type surface. |
| Core exports | `packages/core/src/index.ts` | Public runtime surface. |
| Runtime facade | `packages/core/src/agent-runtime.ts` | Session lifecycle, event emission, sidecar/provider/graph dispatch. |
| Sidecar client | `packages/core/src/native` | Process handshake, status, timeout, mock fallback. |
| Native sidecar entry | `native/sidecar/src/main.rs` | Rust JSONL process entry. |
| Packaging | `scripts/package-cli.ts`, `scripts/install.sh` | CLI tarball and install contract. |
| Workflow contracts | `.github/workflows/*.yml`, `tests/workflow-yaml.test.ts` | CI and release expectations. |
| MCP config schema | `packages/protocol/src/mcp-config.ts` | Local/remote MCP server config, LSP config placeholder, strict schemas. |
| Permission kinds | `packages/protocol/src/permission-profile.ts` | `read`/`edit`/`write`/`patch`/`bash`/`network`/`subagent` PermissionKind union. |
| Skills loader | `packages/core/src/skills/skill-loader.ts` | 3-scope first-wins SKILL.md discovery, denylist, symlink defense. |
| MCP clients | `packages/core/src/tools/mcp/` | Stdio + remote transports, config loader, connection manager, namespaced surfacing, secret redaction. |
| System prompt | `packages/core/src/context/system-prompt.ts` | Persona + env + tools + guidelines + `<available_skills>` XML assembly. |
| Workflow protocol schemas | `packages/protocol/src/{workflow,category,mode,permission-rule,delivery}.ts` | `WorkflowSpecSchema`, `CategorySchema`, `ModeSchema`, `PolicyEffectRuleSchema`, `DELIVERY_MODES`. Workflow policy-gate rules use action/resource/effect. |
| Workflow runtime foundations | see **Workflow Foundations** below | Permission rule algebra, `.omo/` persistence, Mission/Run store, drain-lane coordinator v2, context-source registry, continuation runtime, full-parity `task()` tool. |
| Workflow invocation | `apps/cli/src/commands/chat-commands.ts`, `apps/cli/src/commands/interactive-chat-actions.ts` | `#name {prompt}` parsing and dispatch. `--workflow` non-interactive flag lives in `run-agent.ts`. See **Workflow Invocation** below. |
| Interactive TUI | `apps/cli/src/commands/opentui-chat-bridge.tsx` | opentui keyboard router (KeyEvent adapter), agent spinner, approval overlay, model picker. |
| Workflow tool | `packages/core/src/tools/workflow-tool/workflow-tool.ts` | `workflow(name, prompt)` tool; resolves via `WorkflowRegistry`, returns `started`/`not_found`. |
| Modes + mode overlay | `packages/core/src/behavior/modes/` | `autopilotMode` declaration, `applyMode` pure transform (overlay + policy conversion + tool filter). |
| Built-in workflow graphs | `examples/abg/{default,planner,runner}.workflow.json` | Reference graph instances; autopilot is a mode overlay, not a graph file. |
| Agent loader | `packages/core/src/agents/agent-loader.ts` | `discoverAgents`: 4-scope builtin discovery (project `.mctrl/agents/`, user `<cfg>/agents/`, plugin dirs, bundled) plus 9 cross-harness importers. First-wins by name. Builtin provider runs at priority 100, importers at 50. Symlink defense, denylist pruning, 64KB size bound, 256-agent cap, never throws. |
| Agent capability registry | `packages/core/src/agents/capability/` | `CapabilityRegistry`: priority-sorted `loadAll`, dedups by name (highest priority wins), rejecting providers emit `provider_error` diagnostics. `disableProvider`/`enableProvider` toggle importers. |
| Cross-harness agent importers | `packages/core/src/agents/providers/` | `CROSS_HARNESS_PROVIDERS` (9): Claude Code, Cursor, Codex, Gemini, Cline, Windsurf, VS Code, GitHub Copilot, OpenCode. `registerBuiltinProviders` wires them into the registry. |
| Agent lifecycle manager | `packages/core/src/agents/lifecycle-manager.ts` | `AgentLifecycleManager`: idle to parked to revived TTL lifecycle for adopted subagents (default 7min idle TTL). |
| Async job manager | `packages/core/src/agents/async-job-manager.ts` | `AsyncJobManager`: maxConcurrency semaphore for background child-agent jobs. queued, running, completed, failed, cancelled. Cooperative AbortController cancellation per job. In-memory only. |
| Recursion policy | `packages/core/src/agents/recursion-policy.ts` | `canSpawnAtDepth`, `RecursionTracker`. `DEFAULT_MAX_RECURSION_DEPTH=2`, `HARD_RECURSION_CAP=10` bounds even unlimited recursion. |
| Task tool runtime | `packages/core/src/agents/task-tool-runtime.ts` | `ConcreteTaskToolRuntime`: bridges `task()` to agent resolution, model resolution, child system-prompt assembly, child tool-surface construction. Child surface drops `task`, gains `yield`, removes denied-capability tools. |

## Code Map

| Symbol | Type | Location | Role |
| --- | --- | --- | --- |
| `AgentRuntime` | class | `packages/core/src/agent-runtime.ts` | Main runtime facade. |
| `SessionRunCoordinator` | class | `packages/core/src/runtime/run-coordinator.ts` | Prompt admission and run control. |
| `ProviderTurnRunner` | class | `packages/core/src/providers/provider-turn-runner.ts` | Provider streaming, retries, tool loop bounds. |
| `ToolRegistry` | class | `packages/core/src/tools/tool-registry.ts` | Schema-bound tool registration and invocation. |
| `AgentEventSchema` | Zod schema | `packages/protocol/src/schema.ts` | Shared event contract. |
| `AbgGraphSpecSchema` | Zod schema | `packages/protocol/src/abg.ts` | Authorable graph contract. |
| `SIDECAR_PROTOCOL_VERSION` | const | `packages/protocol/src/sidecar.ts`, `native/sidecar/src/protocol.rs` | Sidecar wire version. |
| `createWorkflowToolRegistration` | function | `packages/core/src/tools/workflow-tool/workflow-tool.ts` | Builds the `workflow` tool that self-invokes a named workflow. |
| `applyMode` | function | `packages/core/src/behavior/modes/mode-application.ts` | Pure transform overlaying a `Mode` onto a graph (prompt + policies + tool filter). |
| `autopilotMode` | const | `packages/core/src/behavior/modes/autopilot-mode.ts` | Built-in `autopilot` mode declaration (edit-gate policy + operating directives overlay). |

## Workflow Foundations

The workflow system is built on eight runtime foundations (Phase 1, Tasks 1.1 through 1.8). Each is self-contained and test-covered. `packages/core/src/runtime/AGENTS.md` and `packages/core/src/context/AGENTS.md` hold the scoped guidance for the runtime and context modules.

| Foundation | Location | Key symbols and notes |
| --- | --- | --- |
| Protocol additions | `packages/protocol/src/{workflow,category,mode,permission-rule,delivery}.ts` | `WorkflowSpecSchema` (graph + metadata), `CategorySchema`/`CategoryCatalogSchema`, `ModeSchema`/`ModeDeclarationSchema`, `PolicyEffectRuleSchema`/`PolicyEffectRuleSetSchema`/`PolicyEffectSchema`, `DELIVERY_MODES`/`DeliverySchema`/`SessionInputDeliverySchema`, `WorkflowDiscoveryDiagnosticSchema`. `PolicyEffectRuleSchema` is the workflow policy-gate shape; the workspace `PermissionRuleSchema` in `permission-profile.ts` is a separate system, do not collapse them. |
| Permission rule algebra | `packages/core/src/permissions/` | `wildcardMatch` (segment glob: `*` stays within a segment, `**` spans segments, `?` one char), `evaluateRules` (flattens rulesets, last-match-wins, defaults to `'ask'`), `deriveChildPermissions` (forwards parent denies, appends a nested-subagent deny; allows intersect implicitly via last-match-wins). |
| `.omo/` persistence | `packages/core/src/persistence/` | `paths.ts` (`resolveOmoRoot`, `ensureOmoDirs`, `isGitignored`), `boulder-store.ts` (`readBoulder`/`writeBoulder`/`updateBoulderWork`, `.passthrough()` schemas preserve orchestrator-authored fields), `plan-store.ts` (`readPlan`, `parsePlanChecklist`), `notepad-store.ts` (`appendNotepad`, `assertAppendOnly`, atomic temp-file-then-rename writes). |
| Mission/Run store | `packages/core/src/runtime/mission-run/` | `mission-store.ts` (`createMission`/`readMission`/`updateMission`/`listMissions`), `run-store.ts` (`createRun`/`readRun`/`updateRunStatus`/`listRunsForMission`, `ALLOWED_RUN_TRANSITIONS`, `assertRunTransition`), `mission-run-service.ts` (`materializeMission` turns a `WorkflowSpec` into a `Mission`, `startRun`, `completeRun`, `failRun`). One JSON file per record under `.omo/{missions,runs}/`; timestamps auto-managed by the service. |
| Steer/queue delivery + run-coordinator v2 | `packages/core/src/runtime/run-coordinator-v2.ts`, `session-input-delivery.ts` | `RunCoordinatorV2` (per-key drain-lane: `run` joins or starts a drain, `wake` coalesces, `interrupt` aborts with seq suppression, `awaitIdle` waits; demand coalescing via `coalesceDemand`; successor lanes on failure), `SessionInputDelivery` (FIFO `admitInput`/`promoteSteers`/`promoteNextQueued`). Native Promise/AbortController port of the opencode Effect drain-lane. |
| System Context Source | `packages/core/src/context/system-context-source.ts`, `mid-conversation-message.ts` | `SystemContextRegistry` (`register`/`remove`/`lookup`/`list`, `getBaselineText`, `getUpdatesSince`, monotonic Context Epoch), `packSystemContextSource` (type-erased carrier), `emitMidConversationSystemMessage` (combines admitted source changes into one system message). Pull-based at safe provider-turn boundaries; source changes never push asynchronously. |
| Session-spanning continuation | `packages/core/src/runtime/continuation/continuation-runtime.ts` | `ContinuationRuntime` (`runWithContinuation`, `shouldContinue`, `advance`, `persistState`/`loadState`, `ContinuationOutcome` with reasons `done_signal`/`max_iterations`/`loop_inactive`). Bounds how many sessions a `loop_active` graph can resume; distinct from graph-level `maxNodeRuns`. State persisted in the boulder work `continuation_runtime` passthrough field. |
| `task()` full parity | `packages/core/src/tools/task/` | `createFullParityTaskToolRegistration` (coexists with the simpler `createTaskToolRegistration` in the sibling `tools/task-tool.ts`), `category-catalog.ts` (`BUILTIN_CATEGORIES`/`getCategory`: quick, deep, ultrabrain, visual-engineering, explore, oracle, librarian, metis, momus), `TaskToolRuntime` (mockable session-lifecycle seam). Child permissions = category rules plus `deriveChildPermissions` denies; nested `task` denied in children. |

## Agent System

The agent system under `packages/core/src/agents/` discovers, validates, and resolves deployable subagents that the `task()` tool spawns as child coding agents. Six logical components cover discovery, registry, lifecycle, and policy. The discovery, parsing, registry, and policy layers are implemented and test-covered; the default spawn function wired into `ConcreteTaskToolRuntime` still throws `not_yet_implemented` until the CLI graph-runner connection (todo 25) lands. Scoped governance lives in `packages/core/src/agents/AGENTS.md`.

| Component | Location | Key symbols and notes |
| --- | --- | --- |
| C1 Discovery and loading | `packages/core/src/agents/agent-loader.ts`, `capability/`, `providers/` | `discoverAgents` orchestrates the builtin 4-scope loader (priority 100) and the 9 cross-harness importers (priority 50) through `CapabilityRegistry.loadAll`. First-wins by name across all providers. Broken files, symlinks, and oversized entries produce diagnostics and are skipped. |
| C2 Registry | `packages/core/src/agents/agent-registry.ts`, `runtime-registry.ts`, `registry.ts` | `AgentIndex` is the by-name lookup built from discovery. `RuntimeAgentRegistry` holds live `AgentRef` entries the lifecycle manager mutates. `registry.ts` keeps the older `SubAgentRegistry` mock surface. |
| C3 Markdown format and parsing | `packages/core/src/agents/agent-parser.ts`, `bundled/` | `parseAgentFile` parses YAML frontmatter plus a markdown body. The body becomes `systemPrompt`. `tools` accepts three on-disk dialects (CSV string, array, object map of enabled tools) normalized to `string[]`. `AgentParseError` on any failure; never returns a partial or defaulted agent. `bundled/` ships the runtime agents (`deep`, `quick`, `ultrabrain`, `visual-engineering`, `explore`, `oracle`, `librarian`, `metis`, `momus`). |
| C4 Recursion policy | `packages/core/src/agents/recursion-policy.ts` | `DEFAULT_MAX_RECURSION_DEPTH=2` (root at depth 0 may spawn a child at depth 1, grandchild at depth 2 is the blocked boundary). `HARD_RECURSION_CAP=10` bounds even `recursion: -1` unlimited configurations. `canSpawnAtDepth` and `RecursionTracker` gate whether a depth may still spawn. |
| C5 Approval tiers | `packages/core/src/agents/approval-tier.ts` | `ToolTier` ranks `read` (0), `write` (1), `exec` (2). `ApprovalMode` values `always-ask` (approves nothing), `write` (auto-approves read and write), `yolo` (auto-approves everything). Per-tool user policies (`prompt`/`deny`/`allow`) override the mode. Child `task()` sessions are forced to `yolo` by `ConcreteTaskToolRuntime`. Separate from `PolicyEffectRuleSchema` and `PermissionRuleSchema` by design. |
| C6 Lifecycle and async jobs | `packages/core/src/agents/lifecycle-manager.ts`, `async-job-manager.ts`, `task-tool-runtime.ts` | `AgentLifecycleManager` owns the idle to parked to revived TTL lifecycle for adopted subagents (default 420000ms idle TTL). `AsyncJobManager` bounds concurrent background child-agent execution via a maxConcurrency semaphore with cooperative `AbortController` cancellation. `ConcreteTaskToolRuntime` bridges `task()` to agent resolution, model resolution, child system-prompt assembly, and child tool-surface construction. |

Agent definition format is markdown with YAML frontmatter, validated by `AgentDefinitionSchema` in `packages/protocol/src/agent.ts`. Required fields are `name`, `description`, and a non-empty body (parsed into `systemPrompt`). Optional fields include `tools`, `spawns` (array or `'*'`), `model` (string or `{providerID, modelID}`), `thinkingLevel` (`low`/`medium`/`high`/`xhigh`), `tier` (`read`/`write`/`exec`), `maxTurns`, `recursion` (`-1` for unlimited), `role`, `pathPolicies`, `autoloadSkills`, and `blocking`. The schema is strict; unknown frontmatter keys are rejected.

Discovery priority, first-wins by name: builtin 4-scope provider (priority 100) scans project `.mctrl/agents/`, user `<config-dir>/agents/`, plugin `additionalDirs`, and bundled templates. The 9 cross-harness importers (priority 50) each scan their own harness directories: Claude Code, Cursor, Codex, Gemini, Cline, Windsurf, VS Code, GitHub Copilot, and OpenCode. A mission-control agent always wins a name conflict over an imported one. Discovery mirrors `discoverSkills` and `discoverWorkflows`: symlink `lstat` defense, shared read-tool denylist pruning, 64KB size bound, 256-agent cap, and never throws.

## Workflow Invocation

Workflows are authorable graphs discovered as `*.workflow.json` or `*.workflow.jsonc` files across three scopes, first-wins by name: global `<config-dir>/workflows/`, project `.mctrl/workflows/`, and project `.agents/workflows/`. The loader (`discoverWorkflows` in `packages/core/src/workflows/workflow-loader.ts`) mirrors `discoverSkills`: symlink defense, shared read-tool denylist, size bound, never throws. Broken files produce `WorkflowDiscoveryDiagnostic` entries logged at bootstrap. Discovered specs land in `WorkflowRegistry` (`packages/core/src/workflows/workflow-registry.ts`), which resolves by name.

`#<workflow-name> {prompt}` invokes a named workflow in interactive chat. `parseWorkflowInvocation` in `apps/cli/src/commands/chat-commands.ts` parses the prefix (known-set gate against discovered names, same name regex as skills). `runWorkflowAction` in `apps/cli/src/commands/interactive-chat-actions.ts` resolves the spec via the registry and threads `spec.graph` through the existing prompt-turn lifecycle. `--workflow <name> "<prompt>"` is the non-interactive equivalent, resolved by `resolveWorkflowInvocation` in `apps/cli/src/commands/run-agent.ts` and mutually exclusive with `--graph`. A prompt with no `#` prefix runs the `default` workflow fallback (`examples/abg/default.workflow.json`).

Key conventions:

- `WorkflowSpecSchema` is strict at the top level; JSONC comments are stripped before `JSON.parse`. Name collisions are first-wins and skipped with a `duplicate_name` diagnostic.
- The workflow graph overrides the default coding-agent graph but reuses the same interactive infrastructure (approval broker, tools, ABG overlay, TUI rendering). It does not spawn a separate runtime.
- `examples/abg/default.workflow.json` and `packages/core/src/behavior/default-workflow-graph.ts` are kept in parity by a JSON-vs-factory test. The graph routes intent-gate to trivial (direct-respond), explicit (memory, todo-plan, delegate-wave, verify-wave critic, supervisor retry loop), or ambiguous (clarify loop).

### Built-in Workflows

| Workflow | Source | Role |
| --- | --- | --- |
| `default` | `examples/abg/default.workflow.json` | No-`#` fallback. Intent gate routes trivial (direct-respond), explicit (memory, todo-plan, delegate-wave, verify-wave critic, supervisor retry loop), or ambiguous (clarify loop) prompts. |
| `planner` | `examples/abg/planner.workflow.json` | Read-only planning. Ambiguity gate routes clear (explore, draft-plan, review), unclear (research, adopt-defaults, draft-plan), or on-the-fence (ask-one-question, re-route) requests. Ships the `planner-readonly` mode: deny all writes except `.omo/plans/**` and `.omo/specs/**`. |
| `runner` | `examples/abg/runner.workflow.json` | Plan execution. Parses a plan checklist, delegates waves via `task()` fan-out with per-task critic verification, updates checkboxes, loops until done, then runs a four-critic final verification wave (goal, constraints, tests, code quality). Routes to complete or fix-loop. |
| `autopilot` | `packages/core/src/behavior/modes/autopilot-mode.ts` | Mode overlay, not a standalone graph. Prepends six operating directives to every `llm` node and adds a hard `edit -> ask` policy-gate rule. Applied to any workflow via `modeDeclarations`. |

### Workflow Tool

`createWorkflowToolRegistration` in `packages/core/src/tools/workflow-tool/workflow-tool.ts` exposes the `workflow(name, prompt)` tool. The model self-invokes a named workflow shown in the `<available_workflows>` system-prompt block. The tool resolves the name through the injected `WorkflowRegistry` and returns `started` or `not_found` (with available names for retry). It validates and resolves only; the runtime adapter routes the resolved `spec.graph` through the same prompt-turn lifecycle as `#name` invocation. Capability class `'workflow'`.

### Modes

A mode is a structural overlay applied at materialization time, not a prompt injection. `applyMode` in `packages/core/src/behavior/modes/mode-application.ts` is a pure function that overlays a `Mode` onto an `AbgGraphSpec` without mutating the input. Three transforms:

- `systemPromptOverlay` is prepended to every `llm`-kind node's `config.systemPrompt`. Node-specific prompts are preserved below.
- `policies` (`PolicyEffectRule[]`: action/resource/effect) are converted to `AbgPolicySpec` entries and appended to `graph.policies`. The `ask` effect maps to `requires_approval`.
- `requiredTools` (when non-empty) intersects each node's `capabilities` with the required set.

Modes are declared in `WorkflowSpec.modes` and activated via `modeDeclarations` on the mission. The graph schema is not modified by mode application; the two policy vocabularies (`PolicyEffectRule` action/resource/effect and `AbgPolicySpec` capability/decision) coexist by design.

## Conventions

- Package manager: `pnpm`; task runner/cache: Nx; compiler: `tsc`; tests: Vitest and Cargo; formatter/linter: Biome; desktop: React + Vite + Tauri v2; runtime validation: Zod.
- Root scripts intentionally prefix Nx with `NX_DAEMON=false NX_ISOLATE_PLUGINS=false`. Keep that unless local sandbox and CI are both verified without it.
- TypeScript stays strict: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and `noPropertyAccessFromIndexSignature` are active.
- Use `import type` for type-only imports. Prefer named exports in app/library code.
- Values crossing package, CLI, desktop, provider, session-log, or sidecar boundaries belong in `packages/protocol` first.
- UI surfaces consume protocol/core events and client abstractions; they must not reach into runtime internals.
- Rust sidecar behavior stays behind the JSON Lines protocol boundary.
- Keep `Cargo.lock` files for Rust crates unless deliberately updating dependencies.
- Biome owns lint/format config. Do not add ESLint or Prettier for routine linting.
- Commit source, docs, tests, config, lockfiles, and workflows. Do not edit generated `dist`, `build`, `target`, `coverage`, `.nx`, `.omo`, `evidence`, `temp`, or reference-repo files.
- Workflow policy-gate rules use `PolicyEffectRuleSchema` (action/resource/effect). The workspace permission store uses `PermissionRuleSchema` (permission/pattern/decision). They coexist by design; pick the one matching the layer you are editing.
- `.omo/` is agent state. Externally-authored files (boulder) use `.passthrough()` schemas and atomic temp-file-then-rename writes so unknown fields survive read-modify-write round-trips.
- `RunCoordinatorV2` and `SessionInputDelivery` are the workflow-path session-spanning drain-lane; the original `run-coordinator.ts` stays for interactive coding-agent runs.

## Anti-Patterns

- Do not remove mock/fallback behavior while the project remains a scaffold.
- Do not implement unrestricted tools, automatic rollback, persistent vector memory, or the full ABG engine unless explicitly requested.
- Do not make `native/sidecar` depend on TypeScript runtime internals.
- Do not serialize raw provider credentials into events, JSONL logs, CLI output, desktop state, errors, or evidence.
- Do not use `any`, `as any`, `as unknown`, `@ts-ignore`, `@ts-expect-error`, or non-null assertions.
- Do not use `unwrap`, `expect`, or `panic` in Rust production code; Cargo lints deny them.
- Do not change release artifact names without updating `scripts`, workflows, README, and contract tests.
- Do not collapse `PolicyEffectRuleSchema` and `PermissionRuleSchema`. They are two separate permission systems on purpose (workflow policy-gate vs workspace permission store).
- Do not route continuation state through `updateBoulderWork`; its patch type excludes custom fields. Read and write the boulder directly so the `continuation_runtime` passthrough field survives.
- Do not let child `task()` sessions spawn their own nested tasks; `deriveChildPermissions` appends a `subagent` deny for `'**'`.

## Commands

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm lint
pnpm dev:cli
pnpm dev:cli -- --no-tui
pnpm dev:cli -- --json
pnpm dev:desktop
pnpm dev:sidecar
pnpm dev:package-cli
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx show projects
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run cli:test
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run desktop:test
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run desktop:tauri-test
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run sidecar:test
cargo test --manifest-path native/sidecar/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## Notes

- Root contract tests under `tests/` lock README language, workflow content, workspace structure, Nx targets, ABG docs, package names, scripts, and protocol exports.
- Package/app tests are colocated as `*.test.ts` or `*.test.tsx`.
- Rust sidecar tests are inline in `native/sidecar`; Tauri Rust tests live under `apps/desktop/src-tauri`.
- `scripts/install.sh` still contains `OWNER_PLACEHOLDER/mission-control`; replace or override it before public release.
- CLI release artifacts are named `mctrl-<os>-<arch>.tar.gz` and contain `mctrl` plus `mission-control-sidecar`.
- Desktop signing/notarization are TODOs until platform credentials exist.
- If a generated artifact must become source, document why before changing `.gitignore`.
