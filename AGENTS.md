# Mission Control Agent Guide

**Generated:** 2026-06-20T00:30:00+09:00
**Commit:** 5b04ce5
**Branch:** master

## Overview

`mission-control` is a staged control surface for observable LLM-agent workflows. It implements a bounded coding-agent MVP over the original scaffold: provider turns, durable SQLite/libSQL sessions, JSONL replay/import/export compatibility, approval-gated tools, replay projections, graph coordination, CLI chat, desktop inspection, and a versioned sidecar handshake. It still does not implement the full ABG engine.

Product names:

- CLI command: `mc` (`mctrl` alias retained)
- Desktop app: `mission-control`
- Native helper binary: `mission-control-sidecar`

Design references:

- `ABG.md`: root design reference.
- `docs/ABG.ko.md`: Korean ABG document.
- `README.md`: scaffold architecture, distribution story, and extension points.

## Structure

```text
mission-control/
|-- apps/cli/                 # mc CLI (argument parsing, command orchestration, noninteractive renderers)
|-- apps/tui/                  # private OpenTUI app: React components, keymap platform, TUI mount/store seam (consumed by apps/cli)
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
- `apps/tui/AGENTS.md`
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
| CLI entry/help/version | `apps/cli/src/index.tsx` | `apps/cli/package.json` maps `mc` and `mctrl` to `./dist/index.js`. |
| CLI command flow | `apps/cli/src/commands/run-agent.ts` | Chat, JSON/JSONL, graph, provider, sidecar selection. |
| CLI output | `apps/cli/src/ui/renderers.ts` | Plain, TUI (buffered summary), and JSON renderer contracts. |
| Interactive chat OpenTUI mount | `apps/tui/src/create-chat-tui.tsx` | Builds the `ChatStore`, mounts the opentui React tree (`@opentui/react` over a node:ffi-loaded Zig core), and returns the `ChatTuiHandle` consumed by the imperative chat loop. |
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
| Config profiles | `apps/cli/src/args.ts`, `packages/core/src/tools/mcp/config.ts` | `--profile <name>` (long-only) selects a user-scope profile file in the config dir, tried in order: `mission-control.<profile>.jsonc`, `mission-control.<profile>.json`, `config.<profile>.jsonc`, `config.<profile>.json` (first existing wins; no fallback). Replaces `config.json` for that run. JSONC comments stripped; trailing commas unsupported. Profile-not-found throws listing the candidates. User-scope writes rewrite the existing candidate or create `mission-control.<profile>.jsonc`. Does NOT change data dir, auth file, session database, trust store, skills, workflows, agents, keybinds, or project `.mcp.json` (`.mcp.<profile>.json[c]` ignored). |
| Permission kinds | `packages/protocol/src/permission-profile.ts` | `read`/`edit`/`write`/`patch`/`bash`/`network`/`subagent` PermissionKind union. |
| Skills loader | `packages/core/src/skills/skill-loader.ts` | 3-scope first-wins SKILL.md discovery, denylist, symlink defense. |
| MCP clients | `packages/core/src/tools/mcp/` | Stdio + remote transports, config loader, connection manager, namespaced surfacing, secret redaction. |
| System prompt | `packages/core/src/context/system-prompt.ts` | Persona + env + tools + guidelines + `<available_skills>` XML assembly. |
| Workflow protocol schemas | `packages/protocol/src/{workflow,category,mode,permission-rule,delivery}.ts` | `WorkflowSpecSchema`, `CategorySchema`, `ModeSchema`, `PolicyEffectRuleSchema`, `DELIVERY_MODES`. Workflow policy-gate rules use action/resource/effect. |
| Workflow runtime foundations | see **Workflow Foundations** below | Permission rule algebra, `.omo/` persistence, Mission/Run store, drain-lane coordinator v2, context-source registry, continuation runtime, full-parity `task()` tool. |
| Workflow invocation | `apps/cli/src/commands/chat-commands.ts`, `apps/cli/src/commands/interactive-chat-actions.ts` | `#name {prompt}` parsing and dispatch. `--workflow` non-interactive flag lives in `run-agent.ts`. See **Workflow Invocation** below. |
| Interactive TUI | `apps/tui/src/app.tsx`, `apps/tui/src/platform/terminal-viewport*.ts`, `apps/tui/src/create-chat-tui.tsx` | Viewport-driven opentui shell, keymap routing, agent spinner, approval overlay, model picker, and imperative `ChatTuiHandle` seam. |
| Workflow tool | `packages/core/src/tools/workflow-tool/workflow-tool.ts` | `workflow(name, prompt)` tool; resolves via `WorkflowRegistry`, returns `started`/`not_found`. |
| Modes + mode overlay | `packages/core/src/behavior/modes/` | `autopilotMode` declaration, `applyMode` pure transform (overlay + policy conversion + tool filter). |
| Built-in workflow graphs | `examples/abg/{default,planner,runner}.workflow.json` | Reference graph instances; autopilot is a mode overlay, not a graph file. Factory functions live in `packages/core/src/behavior/{default,planner,runner}-workflow-graph.ts`; byte-identity is locked by `toEqual` parity tests. |
| Workflow materialization | `packages/core/src/workflows/materialize-workflow.ts`, `apps/cli/src/commands/workflow-materialization.ts` | `materializeWorkflow` folds declared modes onto the executed graph (both CLI paths route through it). `resolveDefaultWorkflowSpec` resolves the plain-prompt `default` fallback. `graphForWorkflowSpec` / `graphForDefaultFallback` are the CLI import surface. |
| Structured blackboard output | `packages/core/src/behavior/structured-blackboard.ts` | `parseStructuredOutput` accepts only a whole exact `outputKey` representation (JSON, boolean, or single-line string) and fails closed on invalid output. It never extracts a trailing line or supplies a default. Wired into `runLlmActorNode`. |
| Parallel fan-out | `packages/core/src/behavior/nodes/parallel-fan-out.ts` | `runParallelFanOut`: the `fanOutKey` branch reads a blackboard array, runs one template child per item under wave-bounded concurrency, and aggregates into `aggregateKey`. It is distinct from static `children` parallelism. |
| Static parallel | `packages/core/src/behavior/nodes/parallel-static.ts` | A `parallel` node without `fanOutKey` runs declared children in waves. A positive integer `config.concurrency` selects the local bound; the default is 2. Signals aggregate in declaration order, and iterator rejection becomes a failure. |
| Race node | `packages/core/src/behavior/nodes/race-node.ts` | Selects the earliest valid completion within the process. Cooperative branches drain during bounded cleanup; a cleanup timeout or iterator/pump rejection fails the Race explicitly; arbitrary work is not forcibly terminated. Durable committed-order arbitration is deferred. |
| Child graph spawn | `packages/core/src/agents/child-graph-spawn.ts` | `createChildGraphSpawnFn`: default child spawn fn with child identity and yield capture. The parent `task()` call stays permission-gated, retained tools preserve workspace approval callbacks, structural filtering removes `task`/`job`, and hard drops remove `subagent`/`workflow`/`network`/`team`. |
| Runner admission + verdict | `packages/core/src/behavior/runner-plan-admission.ts`, `runner-workflow-graph.ts` | `evaluatePlanAdmission` (pure gate rejecting empty/missing-section/no-todos/unapproved plans); `aggregateFinalVerdict` (all-approve → `APPROVE`, else `REJECT`). |
| Runner stop marker | `packages/core/src/persistence/boulder-store.ts`, `runtime/continuation/continuation-runtime.ts` | `runner_stop` typed field on boulder work (`RunnerStopMarkerSchema`); `ContinuationRuntime.markStopped`/`clearStopped`/`isStopped` gate `shouldContinue`. Survives restarts; never auto-resumes. |
| Model variants | `packages/config/src/model-variant-presets.ts`, `packages/core/src/providers/<provider>-request.ts` | `provider/model#variant` selection syntax. Presets and matchers in config; per-provider `<provider>...ForVariant` mapper gated by `isConfigured<Provider>Variant`. Supported: openai (`reasoning-*`), anthropic (`thinking-*`), google 2.5 (`thinking-*`), openrouter/groq/mistral (`reasoning-*`), zai-coding-plan GLM 5.2+ (`reasoning-*` → `thinking.type` + `reasoning_effort`). Stale variant silently dropped. Deferred: gemini-3.x, agent-frontmatter bridge, AI-SDK graph path. See README "Model Variants". |
| Agent loader | `packages/core/src/agents/agent-loader.ts` | `discoverAgents`: 4-scope builtin discovery (project `.mctrl/agents/`, user `<cfg>/agents/`, plugin dirs, bundled) plus 9 cross-harness importers. First-wins by name. Builtin provider runs at priority 100, importers at 50. Symlink defense, denylist pruning, 64KB size bound, 256-agent cap, never throws. |
| Agent capability registry | `packages/core/src/agents/capability/` | `CapabilityRegistry`: priority-sorted `loadAll`, dedups by name (highest priority wins), rejecting providers emit `provider_error` diagnostics. `disableProvider`/`enableProvider` toggle importers. |
| Cross-harness agent importers | `packages/core/src/agents/providers/` | `CROSS_HARNESS_PROVIDERS` (9): Claude Code, Cursor, Codex, Gemini, Cline, Windsurf, VS Code, GitHub Copilot, OpenCode. `registerBuiltinProviders` wires them into the registry. |
| Agent lifecycle manager | `packages/core/src/agents/lifecycle-manager.ts` | `AgentLifecycleManager`: idle to parked to revived TTL lifecycle for adopted subagents (default 7min idle TTL). |
| Async job manager | `packages/core/src/agents/async-job-manager.ts` | `AsyncJobManager`: maxConcurrency semaphore for background child-agent jobs. queued, running, completed, failed, cancelled. Cooperative AbortController cancellation per job. In-memory only. |
| Recursion compatibility | `packages/core/src/agents/recursion-policy.ts` | Standalone `canSpawnAtDepth` / `RecursionTracker` utility with `DEFAULT_MAX_RECURSION_DEPTH=2` and `HARD_RECURSION_CAP=10`. Production `task()` routing does not consult it. |
| Task tool runtime | `packages/core/src/agents/task-tool-runtime.ts` | `ConcreteTaskToolRuntime`: bridges `task()` to agent resolution, model resolution, child system-prompt assembly, child tool-surface construction. Every child surface drops `task`/`job`, gains `yield`, and removes denied-capability tools. |

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
| `materializeWorkflow` | function | `packages/core/src/workflows/materialize-workflow.ts` | Shared seam that folds each declared `Mode` (via `applyMode`) onto a `WorkflowSpec`'s graph so mode overlays reach the executed graph. `resolveDefaultWorkflowSpec` resolves the `default` fallback with a factory-graph backstop. |
| `parseStructuredOutput` | function | `packages/core/src/behavior/structured-blackboard.ts` | Parses a workflow `llm` node's whole exact turn text (bare/fenced JSON, boolean, or single-line string) into a typed value for `outputKey` persistence; fails closed on unparseable output with no trailing-line or default fallback. |
| `runParallelFanOut` | function | `packages/core/src/behavior/nodes/parallel-fan-out.ts` | `parallel` node's `fanOutKey` branch: reads a blackboard array, runs one template child per item under wave-bounded concurrency, aggregates `{item,index,result,failed}` into `aggregateKey`. |
| `createChildGraphSpawnFn` | function | `packages/core/src/agents/child-graph-spawn.ts` | Default child spawn fn: runs a bounded child coding-agent graph with the child's own identity and captures its yielded result. Parent task gating and retained workspace approval callbacks remain active; category rules, `AgentDefinition.pathPolicies`, and hard drops add independent limits. |
| `aggregateFinalVerdict` | function | `packages/core/src/behavior/runner-workflow-graph.ts` | Pure `'APPROVE'` iff every F1-F4 critic output is `'APPROVE'`, else `'REJECT'` (fail-closed). The runner `final-verification-wave` node aggregates via `verdictStrategy: 'all-approve'`. |
| `evaluatePlanAdmission` | function | `packages/core/src/behavior/runner-plan-admission.ts` | Pure runner plan-admission gate: rejects empty/missing-section/no-todos/unapproved plans with typed codes; accepts on `Status: Approved|Ready|Accepted`. |

## Workflow Foundations

The workflow system is built on eight runtime foundations (Phase 1, Tasks 1.1 through 1.8). Each is self-contained and test-covered. `packages/core/src/runtime/AGENTS.md` and `packages/core/src/context/AGENTS.md` hold the scoped guidance for the runtime and context modules.

| Foundation | Location | Key symbols and notes |
| --- | --- | --- |
| Protocol additions | `packages/protocol/src/{workflow,category,mode,permission-rule,delivery}.ts` | `WorkflowSpecSchema` (graph + metadata), `CategorySchema`/`CategoryCatalogSchema`, `ModeSchema`/`ModeDeclarationSchema`, `PolicyEffectRuleSchema`/`PolicyEffectRuleSetSchema`/`PolicyEffectSchema`, `DELIVERY_MODES`/`DeliverySchema`/`SessionInputDeliverySchema`, `WorkflowDiscoveryDiagnosticSchema`. `PolicyEffectRuleSchema` is the workflow policy-gate shape; the workspace `PermissionRuleSchema` in `permission-profile.ts` is a separate system, do not collapse them. |
| Permission rule algebra | `packages/core/src/permissions/` | `wildcardMatch` (segment glob: `*` stays within a segment, `**` spans segments, `?` one char), `evaluateRules` (flattens rulesets, last-match-wins, defaults to `'ask'`). |
| `.omo/` persistence | `packages/core/src/persistence/` | `paths.ts` (`resolveOmoRoot`, `ensureOmoDirs`, `isGitignored`), `boulder-store.ts` (`readBoulder`/`writeBoulder`/`updateBoulderWork`, `.passthrough()` schemas preserve orchestrator-authored fields), `plan-store.ts` (`readPlan`, `parsePlanChecklist`), `notepad-store.ts` (`appendNotepad`, `assertAppendOnly`, atomic temp-file-then-rename writes). |
| Mission/Run store | `packages/core/src/runtime/mission-run/` | `mission-store.ts` (`createMission`/`readMission`/`updateMission`/`listMissions`), `run-store.ts` (`createRun`/`readRun`/`updateRunStatus`/`listRunsForMission`, `ALLOWED_RUN_TRANSITIONS`, `TERMINAL_RUN_STATUSES`, `assertRunTransition`), `mission-run-service.ts` (`materializeMission`, `startRun`, `blockRun`, `cancelRun`, `completeRun`, `failRun`). SQL `mission_runs` rows in `mission-control.db` are authoritative durable Run storage. JSONL is a session timeline and replay/import/export compatibility format, not an authoritative Run store; `.omo/{missions,runs}/*.json` is separately store-owned compatibility data. A blocked Run is nonterminal, resumable through `blocked -> running`, cancellable through `blocked -> cancelled`, has no `terminalReason`, and retains its optional session link. A cancelled Run is terminal and non-resumable; cancellation records a `terminalReason` and auto-managed `endedAt`. |
| Steer/queue delivery + run-coordinator v2 | `packages/core/src/runtime/run-coordinator-v2.ts`, `session-input-delivery.ts` | `RunCoordinatorV2` (per-key drain-lane: `run` joins or starts a drain, `wake` coalesces, `interrupt` aborts with seq suppression, `awaitIdle` waits; demand coalescing via `coalesceDemand`; successor lanes on failure), `SessionInputDelivery` (FIFO `admitInput`/`promoteSteers`/`promoteNextQueued`). Native Promise/AbortController port of the opencode Effect drain-lane. |
| System Context Source | `packages/core/src/context/system-context-source.ts`, `mid-conversation-message.ts` | `SystemContextRegistry` (`register`/`remove`/`lookup`/`list`, `getBaselineText`, `getUpdatesSince`, monotonic Context Epoch), `packSystemContextSource` (type-erased carrier), `emitMidConversationSystemMessage` (combines admitted source changes into one system message). Pull-based at safe provider-turn boundaries; source changes never push asynchronously. |
| Session-spanning continuation | `packages/core/src/runtime/continuation/continuation-runtime.ts` | `ContinuationRuntime` (`runWithContinuation`, `shouldContinue`, `advance`, `persistState`/`loadState`, `ContinuationOutcome` with reasons `done_signal`/`max_iterations`/`loop_inactive`). Bounds how many sessions a `loop_active` graph can resume; distinct from graph-level `maxNodeRuns`. State persisted in the boulder work `continuation_runtime` passthrough field. |
| `task()` full parity | `packages/core/src/tools/task/` | `createFullParityTaskToolRegistration` (coexists with the simpler `createTaskToolRegistration` in the sibling `tools/task-tool.ts`), `category-catalog.ts` (`BUILTIN_CATEGORIES`/`getCategory`: quick, deep, reasoner, designer, explore, oracle, librarian, planner, reviewer), `TaskToolRuntime` (mockable session-lifecycle seam). Child permissions end with a nested-subagent deny, child registries omit `task`/`job`, and no recursion metadata can re-enable either guard; parent-agent denies come only from `AgentDefinition.pathPolicies`. |

### ABG Alignment Runtime Seams

Beyond the Phase 1 foundations, the ABG reference alignment work added runtime seams that the built-in `#default` / `#planner` / `#runner` graphs rely on. Each is self-contained, pure where stated, and test-covered (`packages/core/src/behavior/abg-reference-parity.test.ts` is the companion regression suite; `docs/abg-reference-parity-matrix.md` is the 22-row status matrix).

| Seam | Location | Key symbols and notes |
| --- | --- | --- |
| Workflow materialization | `packages/core/src/workflows/materialize-workflow.ts` | `materializeWorkflow(spec, options?)` is the pure fold over `spec.modes` via `applyMode` that both CLI invocation paths route through, so mode overlays (`planner-readonly`, `autopilot`) reach the EXECUTED graph. `resolveDefaultWorkflowSpec` resolves the plain-prompt `default` fallback with a factory-graph backstop. |
| Structured blackboard state | `packages/core/src/behavior/structured-blackboard.ts` | `parseStructuredOutput(rawText, shape?)` accepts only bare/fenced JSON, exact booleans, or a single-line string as the whole `outputKey` value and FAILS CLOSED otherwise. `runLlmActorNode` writes the parsed value to `config.outputKey` and emits a `blackboard.set` event. Nodes without `outputKey` are unchanged. Supported vocabulary: `intent.classification`, `plan.todos`, `plan.ready`, `wave.tasks`, `delegate.results`, `final.verdict`, etc. (parser is key-agnostic). |
| Parallel `fanOutKey` fan-out | `packages/core/src/behavior/nodes/parallel-fan-out.ts` | `runParallelFanOut` reads a blackboard array via `fanOutKey`, runs the single template child once per item under wave-bounded concurrency (default 2), aggregates `{item,index,result,failed}` into `aggregateKey` (default `delegate.results`), and sets `completionKey` only after all items settle. It is separate from static `children` parallelism. Fail-closed on missing key / non-array / unresolved template; `continueOnFailure` opts out of parent failure. |
| Static parallel + Race | `packages/core/src/behavior/nodes/{parallel-static,race-node}.ts` | Static `children` parallelism uses positive integer `config.concurrency` or the local default of 2, preserves declaration-order aggregation, and converts iterator rejection into failure. Race chooses the earliest valid process-local completion. Cooperative branches drain during bounded cleanup; a cleanup timeout or iterator/pump rejection fails the Race explicitly; arbitrary work is not forcibly terminated. Durable committed-order arbitration is deferred. |
| Child task identity | `packages/core/src/agents/child-graph-spawn.ts` | `createChildGraphSpawnFn` is the default spawn fn: runs a bounded coding-agent graph with the child's own identity (agent body as system prompt injected into `llm-actor`) and a pre-built child surface (yield present, task absent). The parent `task()` invocation gate and retained workspace approval callbacks remain active; category rules, `AgentDefinition.pathPolicies`, and hard drops add independent limits. Resumes require a matching authority fingerprint. A missing yield returns a failed, bounded degraded salvage summary. `CHILD_HARD_DROPPED_CAPABILITY_KINDS` = `subagent`/`workflow`/`network`/`team` (narrower than destructive kinds, which stay policy-controlled). |
| Runner plan-admission gate | `packages/core/src/behavior/runner-plan-admission.ts` | `evaluatePlanAdmission(planText)` is the pure gate (codes: `plan_empty`/`missing_section`/`no_todos`/`not_approved`) that the runner `admit-plan` entry node uses to reject missing/malformed/unapproved plans to a terminal node before any task delegation runs. |
| Section-scoped plan parsing | `packages/core/src/persistence/plan-store.ts` | `parsePlanChecklistText` counts only column-0 checkboxes under `## Todos`/`## TODOs` and `## Final Verification Wave` headings (ignoring Notes, Acceptance, Evidence, etc.); falls back to all top-level checkboxes when no counted heading exists. Surfaces `nextTaskLabel`. |
| Runner F1-F4 verdict aggregation | `packages/core/src/behavior/runner-workflow-graph.ts` | `aggregateFinalVerdict(verdicts)` is pure: `'APPROVE'` iff every critic output is `'APPROVE'`, else `'REJECT'` (fail-closed). The `final-verification-wave` parallel node declares `verdictStrategy: 'all-approve'` and aggregates F1-F4 into a single string `final.verdict`. |
| Runner 3-strike escalation | `packages/core/src/behavior/runner-workflow-graph.ts` | `fix-loop` carries a bounded strike counter (`strikeBudget: 3`, `strikeKey: 'fix.strikes'`); under budget it reopens tasks and reuses the persisted child session id (`retryStateKey`) so the retried child resumes with full context; at budget it routes to a terminal `blocked-escalation` node. Pure contract `routeFixLoop(strikes, budget)`. |
| Runner stop marker | `packages/core/src/persistence/boulder-store.ts`, `runtime/continuation/continuation-runtime.ts` | `RunnerStopMarkerSchema` (`runner_stop` typed field on boulder work, survives `.passthrough()` round-trips). `ContinuationRuntime.markStopped`/`clearStopped`/`isStopped` gate `shouldContinue`. Stopped work stays stopped across restarts; only `clearStopped()` (explicit resume) re-enables continuation. |
| Runner checkbox discipline | `packages/core/src/behavior/runner-workflow-graph.ts` | `checkbox-update` node declares `planPath`, `verifyBeforeCheckbox: true`, `readBackAfterUpdate: true`: MUST NOT flip a checkbox on a child "done" claim, must independently verify (tests/files/diagnostics), then re-read the plan to confirm the unchecked count decreased. Mirrors the Atlas `<post_delegation_rule>`. |

## Agent System

The agent system under `packages/core/src/agents/` discovers, validates, and resolves deployable subagents that the `task()` tool spawns as child coding agents. Six logical components cover discovery, registry, lifecycle, and policy. Discovery, parsing, registry, policy, and the default spawn function are all implemented and test-covered. The default spawn fn (`createChildGraphSpawnFn` in `child-graph-spawn.ts`) runs a bounded coding-agent graph with the child's own identity when a `resolveSdkModel` is provided; it hard-drops `subagent`/`workflow`/`network`/`team` capability classes, preserves the child system prompt, captures the yielded result, and rejects only in pure-test mode without a real provider. Scoped governance lives in `packages/core/src/agents/AGENTS.md`.

| Component | Location | Key symbols and notes |
| --- | --- | --- |
| C1 Discovery and loading | `packages/core/src/agents/agent-loader.ts`, `capability/`, `providers/` | `discoverAgents` orchestrates the builtin 4-scope loader (priority 100) and the 9 cross-harness importers (priority 50) through `CapabilityRegistry.loadAll`. First-wins by name across all providers. Broken files, symlinks, and oversized entries produce diagnostics and are skipped. |
| C2 Registry | `packages/core/src/agents/agent-registry.ts`, `runtime-registry.ts`, `registry.ts` | `AgentIndex` is the by-name lookup built from discovery. `RuntimeAgentRegistry` holds live `AgentRef` entries the lifecycle manager mutates. `registry.ts` keeps the older `SubAgentRegistry` mock surface. |
| C3 Markdown format and parsing | `packages/core/src/agents/agent-parser.ts`, `bundled/` | `parseAgentFile` parses YAML frontmatter plus a markdown body. The body becomes `systemPrompt`. `tools` accepts three on-disk dialects (CSV string, array, object map of enabled tools) normalized to `string[]`. `AgentParseError` on any failure; never returns a partial or defaulted agent. `bundled/` ships the runtime agents (`deep`, `quick`, `reasoner`, `designer`, `explore`, `oracle`, `librarian`, `planner`, `reviewer`). |
| C4 Recursion compatibility | `packages/core/src/agents/recursion-policy.ts` | `canSpawnAtDepth`, `RecursionTracker`, `DEFAULT_MAX_RECURSION_DEPTH=2`, and `HARD_RECURSION_CAP=10` model standalone compatibility depth. They are not wired into production task routing, whose child surfaces always omit `task`/`job`. |
| C5 Approval tiers | `packages/core/src/agents/approval-tier.ts` | `ToolTier` ranks `read` (0), `write` (1), `exec` (2). `ApprovalMode` values `always-ask` (approves nothing), `write` (auto-approves read and write), `yolo` (auto-approves everything). Per-tool user policies (`prompt`/`deny`/`allow`) override the mode. Child sessions preserve workspace callbacks and gain category, `AgentDefinition.pathPolicies`, and hard-drop limits; they do not force tier metadata to `yolo`. Workspace `PermissionRule` and workflow `PolicyEffectRule` remain separate systems. |
| C6 Lifecycle and async jobs | `packages/core/src/agents/lifecycle-manager.ts`, `async-job-manager.ts`, `task-tool-runtime.ts` | `AgentLifecycleManager` owns the idle to parked to revived TTL lifecycle for adopted subagents (default 420000ms idle TTL). `AsyncJobManager` bounds concurrent background child-agent execution via a maxConcurrency semaphore with cooperative `AbortController` cancellation. `ConcreteTaskToolRuntime` bridges `task()` to agent resolution, model resolution, child system-prompt assembly, and child tool-surface construction. |

Agent definition format is markdown with YAML frontmatter, validated by `AgentDefinitionSchema` in `packages/protocol/src/agent.ts`. Required fields are `name`, `description`, and a non-empty body (parsed into `systemPrompt`). Optional fields include `tools`, `spawns` (array or `'*'`), `model` (string or `{providerID, modelID}`), `thinkingLevel` (`low`/`medium`/`high`/`xhigh`), `tier` (`read`/`write`/`exec`), `maxTurns`, `recursion` (compatibility metadata; `-1` preserves an imported unlimited-depth declaration without granting nested production task authority), `role`, `pathPolicies`, `autoloadSkills`, and `blocking`. The schema is strict; unknown frontmatter keys are rejected.

Discovery priority, first-wins by name: builtin 4-scope provider (priority 100) scans project `.mctrl/agents/`, user `<config-dir>/agents/`, plugin `additionalDirs`, and bundled templates. The 9 cross-harness importers (priority 50) each scan their own harness directories: Claude Code, Cursor, Codex, Gemini, Cline, Windsurf, VS Code, GitHub Copilot, and OpenCode. A mission-control agent always wins a name conflict over an imported one. Discovery mirrors `discoverSkills` and `discoverWorkflows`: symlink `lstat` defense, shared read-tool denylist pruning, 64KB size bound, 256-agent cap, and never throws.

## Workflow Invocation

Workflows are authorable graphs discovered as `*.workflow.json` or `*.workflow.jsonc` files across three scopes, first-wins by name: global `<config-dir>/workflows/`, project `.mctrl/workflows/`, and project `.agents/workflows/`. The loader (`discoverWorkflows` in `packages/core/src/workflows/workflow-loader.ts`) mirrors `discoverSkills`: symlink defense, shared read-tool denylist, size bound, never throws. Broken files produce `WorkflowDiscoveryDiagnostic` entries logged at bootstrap. Discovered specs land in `WorkflowRegistry` (`packages/core/src/workflows/workflow-registry.ts`), which resolves by name.

`#<workflow-name> {prompt}` invokes a named workflow in interactive chat. `parseWorkflowInvocation` in `apps/cli/src/commands/chat-commands.ts` parses the prefix (known-set gate against discovered names, same name regex as skills). `runWorkflowAction` in `apps/cli/src/commands/interactive-chat-actions.ts` resolves the spec via the registry and threads the materialized graph (via `graphForWorkflowSpec`, which calls `materializeWorkflow`) through the existing prompt-turn lifecycle. `--workflow <name> "<prompt>"` is the non-interactive equivalent, resolved by `resolveWorkflowInvocation` in `apps/cli/src/commands/run-agent.ts` and mutually exclusive with `--graph`. A prompt with no `#` prefix runs the `default` workflow fallback (`examples/abg/default.workflow.json`) resolved through `graphForDefaultFallback` (plain prompts do NOT create Mission/Run records).

Key conventions:

- `WorkflowSpecSchema` is strict at the top level; JSONC comments are stripped before `JSON.parse`. Name collisions are first-wins and skipped with a `duplicate_name` diagnostic.
- The workflow graph overrides the default coding-agent graph but reuses the same interactive infrastructure (approval broker, tools, ABG overlay, TUI rendering). It does not spawn a separate runtime.
- `examples/abg/default.workflow.json` and `packages/core/src/behavior/default-workflow-graph.ts` are kept in parity by a JSON-vs-factory test. The graph routes intent-gate to trivial (direct-respond), exploratory-research (read-only), open-ended-planning (route-planner, never implements), explicit-implementation (memory, maturity-check, anti-dup guard, todo-plan, delegate-wave, verify-wave critic, evidence-check, supervisor 3-strike retry loop), or ambiguous (clarify loop).

### Built-in Workflows

| Workflow | Source | Role |
| --- | --- | --- |
| `default` | `examples/abg/default.workflow.json` | No-`#` fallback. The intent gate requires exactly one of five class strings, then routes `trivial` (direct-respond), `exploratory-research` (read-only research-explore), `open-ended-planning` (route-planner; never implements), `explicit-implementation` (memory, maturity-check, anti-dup/delegation-bias guard, todo-plan, delegate-wave, per-task verify-wave critic, evidence-check, supervisor 3-strike retry loop, final-respond), or `ambiguous` (clarify loop). Intent verbalization is deferred. Declares no modes; `materializeWorkflow` returns the base graph unchanged. |
| `planner` | `examples/abg/planner.workflow.json` | Sticky read-only planning (never implements). Ambiguity gate (`assess-ambiguity`) routes clear (explore-filter, optional explore, draft-plan), unclear (research, adopt-defaults, draft-plan), or on-the-fence (ask-one-question). Drafts to `.omo/drafts/`, Metis/Momus-style `review-plan` approve-biased gate, `approval-gate` blocks on `plan.ready`, then `write-plan` commits the scaffold to `.omo/plans/<slug>.md` with `Status: Approved`. Ships the `planner-readonly` mode (applied via `materializeWorkflow`): deny all writes except `.omo/plans/**`, `.omo/specs/**`, and `.omo/drafts/**`. |
| `runner` | `examples/abg/runner.workflow.json` | Plan execution. Entry `admit-plan` is a plan-admission gate (rejects missing/malformed/unapproved plans to a terminal node). Section-scoped `parse-plan`, 6-section delegation via `fanOutKey` wave-bounded fan-out, `per-task-verify`, verify-before-checkbox `checkbox-update` with read-back confirmation, F1-F4 `final-verification-wave` with verdict aggregation (`aggregateFinalVerdict`, `verdictStrategy: 'all-approve'`), and a bounded 3-strike `fix-loop` escalating to terminal `blocked-escalation` at budget. Routes to complete or fix-loop. |
| `autopilot` | `packages/core/src/behavior/modes/autopilot-mode.ts` | Mode overlay, not a standalone graph. Prepends six operating directives to every `llm` node and adds a hard `edit -> ask` policy-gate rule. Applied to any workflow via `modeDeclarations`. Not auto-applied to `default` (it declares no modes). |

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
- Do not let child `task()` sessions spawn their own nested tasks; task routing appends a `subagent` deny for `'**'`.

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
- CLI release artifacts are named `mctrl-<os>-<arch>.tar.gz` and contain `mc`, the `mctrl` alias, and `mission-control-sidecar`.
- Desktop signing/notarization are TODOs until platform credentials exist.
- If a generated artifact must become source, document why before changing `.gitignore`.
