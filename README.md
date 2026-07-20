# mission-control

`mission-control` is a staged control surface for operating observable LLM-agent workflows. The primary command-line entrypoint is `mc`, `mctrl` remains available as an alias, the desktop app is `mission-control`, and the native helper binary is `mission-control-sidecar`.

## Architecture

`ABG.md` is the root design reference. The current runtime implements a bounded coding-agent MVP over the original scaffold: provider turns, durable SQLite/libSQL sessions with JSONL replay/import/export compatibility, approval-gated tools, replay projections, graph coordination, behavior/action graph execution for authorable graphs, CLI chat, desktop inspection, core desktop command services, and a versioned sidecar handshake.

Directory structure:

- `apps/cli`: `mc` command-line app (`mctrl` alias retained). Owns argument parsing, command orchestration, and the noninteractive renderers.
- `apps/tui`: private Solid/OpenTUI TUI app consumed by `apps/cli` (Solid JSX components, keymap platform, TUI mount/store seam). Not publishable.
- `apps/desktop`: Tauri + React desktop app.
- `packages/protocol`: shared event/session/sidecar schemas.
- `packages/core`: runtime services, durable session replay, provider turns, approval-gated tools, graph coordination, and sidecar client boundary.
- `packages/config`: shared constants.
- `native/sidecar`: Rust JSON Lines sidecar binary.
- `tests`: root workspace and integration contract tests.

Package responsibilities:

- `@mission-control/protocol`: shared schemas and types for CLI, desktop, core runtime, and Rust sidecar boundaries.
- `@mission-control/core`: runtime skeleton, event stream concepts, session snapshots, permissions, and native sidecar client boundaries.
- `@mission-control/config`: shared configuration constants.
- `@mission-control/cli`: opentui/plain/JSON command-line surface for `mc`. Lazy-loads the TUI mount from `@mission-control/tui` only when the interactive TUI is active; noninteractive `--no-tui`/`--json`/`--jsonl` runs never touch opentui or the Solid TUI runtime.
- `@mission-control/tui`: private internal Solid/OpenTUI app (`@opentui/solid` + `solid-js`, TUI mount/store seam, keymap platform). Not publishable; consumed by `@mission-control/cli` via lazy import.
- `@mission-control/desktop`: Tauri + React desktop surface for `mission-control`.
- `native/sidecar`: Rust JSON Lines sidecar with protocol v1 `task.run` negotiation and opt-in protocol v2 compatibility tests.

Confirmed names:

- `apps/cli/package.json` maps the `mc` and `mctrl` bins to `./dist/index.js`.
- Tauri desktop product name is `mission-control`.
- `native/sidecar/Cargo.toml` builds the `mission-control-sidecar` binary.

## Commands

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm dev:cli
pnpm dev:cli -- --no-tui
pnpm dev:cli -- --json
pnpm dev:cli -- --no-tui --provider local --model local-echo
pnpm dev:cli -- --json --model local/local-echo
pnpm dev:cli -- --json --graph examples/abg/research-answer.graph.json
pnpm dev:cli -- --no-tui --workspace /path/to/target-project --provider local --model local-echo "summarize this project"
pnpm dev:cli -- auth login --provider local --api-key <key>
pnpm dev:cli -- auth login --provider anthropic --api-key <key>
pnpm dev:cli -- auth login --provider openai --method oauth-headless
pnpm dev:cli -- auth login --provider github-copilot --method oauth
pnpm dev:cli -- auth login --provider xai --method oauth
pnpm dev:cli -- auth login --provider cloudflare-ai-gateway --credential apiToken=<token> --credential accountId=<account> --credential gatewayId=<gateway>
pnpm dev:cli -- auth login
pnpm dev:cli -- auth list
pnpm dev:cli -- auth logout --provider local
pnpm dev:cli -- models local
pnpm dev:sidecar
pnpm dev:desktop
pnpm --filter @mission-control/cli build
pnpm smoke:coding-agent-built-dist
node apps/cli/dist/index.js --no-tui
```

`workspace:test` builds the CLI and its package dependencies before running the root Vitest suites. For a direct focused run of the two built-CLI suites, build that artifact once first:

```bash
NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run cli:build
pnpm exec vitest run tests/cli-local-db-concurrency.test.ts tests/cli-custom-workflow-tool-call-id.test.ts
```

## mc agents

The `mc agents` command inspects and manages discovered agents from the command line (non-interactive; the interactive equivalent is `/agents`).

```bash
mc agents list
mc agents show <name>
mc agents unpack [--all] [<name>] [--force] [--user|--project|--dir <path>] [--json]
mc agents disable <name>
mc agents enable <name>
mc agents import <harness> <path>
```

- `mc agents list` lists every discovered agent with its source, model, and tier.
- `mc agents show <name>` shows full details for one agent (description, tools, spawns, thinking level, max turns, recursion, file path, disabled status).
- `mc agents unpack` copies bundled agent templates to `.mctrl/agents/`. With no flags it copies a single named agent; `--all` copies every bundled agent. `--force` overwrites existing files (bulk mode skips on collision by default). The default scope is the project directory (`<workspace>/.mctrl/agents/`); `--user` targets `<config-dir>/agents/`, `--project` is the explicit default, and `--dir <path>` targets a custom directory. `--json` emits machine-readable output.
- `mc agents disable <name>` hides an agent from discovery so it cannot be spawned via `task()`.
- `mc agents enable <name>` re-enables a previously disabled agent.
- `mc agents import <harness> <path>` imports a harness agent file into `.mctrl/agents/`.

## Interactive chat commands

`mc` opens a chat prompt by default; `mctrl` is a compatibility alias. `/model opens a searchable model picker`, and `/model provider/model selects the model for the current chat only`. The selection updates the active chat model and does not persist credentials or auth defaults.

`/models` (plural) opens a full-width, two-column overlay for assigning models to the ten built-in agent roles, not for changing the active chat model. The left column lists the assignable models as `provider/model[#variant]` entries, and the right column lists each role with its current assignment or default-inheritance status. Arrow keys move the focus within a column, `Tab` switches columns, `Enter` assigns the focused model to the focused role, `Backspace` or `Delete` clears a role back to its default, and `Escape` closes the overlay. Assignments persist to the user auth file under the Mission Control data directory, so they are personal preferences and are not committed to the project. A role with no explicit assignment shows `Using default (<provider>/<model[#variant]>)`, except the default role itself, which shows `Using built-in/session default (<provider>/<model[#variant]>)`. A child agent that declares `model: 'mctrl/<role>'` resolves to the persisted assignment for that role when one exists, except exact `mctrl/task`, which inherits the active parent model or the session default. `/model` (the active-session selection) and `mc models` (the non-interactive listing) are unchanged.

Session navigation stays on the durable SQLite/libSQL session surface: `/new [session-id]` starts a new durable session, `/session <session-id>` switches to an existing durable session, `/sessions` lists durable sessions, `/tree` shows the durable session tree and active leaf, `/branch <entry-id>` selects an existing branch leaf, `/branch <message-id> <prompt>` continues from a parent message in a new branch, `/fork <entry-id> [session-id]` forks from a tree entry into a new durable session, and `/clone [session-id]` clones the current durable session into a fresh one. JSONL remains a replay/import/export compatibility format and is not deleted during import. `/compact` summarizes older session history into a durable compaction boundary event, keeping the session durable while reducing replay context. `/session` with no argument opens a searchable picker of sessions previously opened in the current project (selecting one attaches to it). `/resume` resumes the most recent session for this project. `/continue` resumes a blocked run that is waiting on an approval decision, re-entering the approval-blocked lifecycle.

Workspace trust is controlled interactively with `/trust` (trust the current workspace for project-local resources), `/trust status` (show the current trust decision), `/trust deny` (deny project-local resources for the workspace), and `/trust reset` (clear the trust decision). Trust decisions persist in the project trust store under the Mission Control data directory. `bash.run`, `file.edit`, and `file.write` are only available when the workspace is trusted; `eval` has the same trust requirement. Read-only tools work regardless of trust but still enforce workspace path guards.

`$name [args]` loads the named skill's `SKILL.md` body and submits it as the user message (real skill loading, replacing the old scaffold recorder). Skill chat syntax is dollar-prefix only; a bare `/name` is never a skill expansion. `!command` runs a shell command and submits the output to the model; `!!command` runs a shell command and displays the output only (no model submit). Both bash prefixes require a trusted workspace (`/trust`). Skill bodies are inert text only; it does not run actual Codex host skills, spawn agents, or make provider calls on its own. Normal prompt text still sends a prompt, and Ctrl+C twice exits.

`#<workflow-name> {prompt}` invokes a named workflow with the given prompt. Workflows are discovered from `.mctrl/workflows/`, `.agents/workflows/`, and the config workflows directory. A prompt without a `#` prefix runs the `default` workflow fallback. Four built-in workflows ship with the runtime: `default` (intent-gated plain-prompt implementer), `planner` (deep planning), `executer` (plan execution), `fixer` (intent-gated implement), and `autopilot` (a mode overlay applied to any workflow). See Built-in Workflows below.

`/agents` inspects and manages discovered agents. `/agents` with no argument opens the agent control dashboard in the TUI (or prints the discovered-agents list as text when the TUI is unavailable). `/agents list` prints the discovered-agents list as text with source, model, and tier. `/agents <name>` shows full details for one agent (description, tools, spawns, thinking level, max turns, recursion, file path, disabled status). `/agents reload` re-runs discovery without restarting the chat. `/agents disable <name>` disables a single agent so it cannot be spawned via `task()`. The reserved subcommands `dashboard`, `list`, `reload`, and `disable` take precedence over any agent literally named with those tokens; use `mc agents show <name>` to inspect an agent whose name collides. See Agent System below.

The chat command surface is mixed: normal prompts can run through the deterministic local provider, OpenAI Responses, Anthropic Messages, Google Gemini, or the OpenAI-compatible adapter family for OpenRouter, Groq, DeepSeek, Mistral, and ZAI Coding Plan when credentials are configured. Skill loading is real — the `SKILL.md` body becomes the next user prompt. The default `local/local-echo` provider is not a general-purpose tool-calling provider, although its scripted `deterministic patch` path emits `file.patch` and optional `command.run` calls for offline tests. A real tool-calling provider is required for general agentic behavior driven by loaded skills.

## Keyboard Shortcuts

Interactive chat chords are defined in the keybind registry (`apps/tui/src/platform/keymap/keybind.ts`) and rebindable via a `keybinds.json` config file. `/hotkeys` lists every binding grouped by namespace and auto-reflects any rebind. A few chords are resolved against the textarea's native editing defaults so both the app action and the editing behavior survive:

- `Ctrl+E` opens the external editor (input line-end is `Ctrl+Shift+E`).
- `Ctrl+Z` suspends the terminal (undo/redo are `Ctrl+-` / `Ctrl+.`).
- `Home` / `End` scroll the transcript (buffer-home/end are `Ctrl+Shift+Home` / `Ctrl+Shift+End`).
- `Ctrl+P` cycles the model (the command palette is `Alt+X`).
- `Ctrl+G` toggles the full ABG monitoring overlay.
- `Ctrl+X` then `G` toggles the ABG minimap (a compact upper-right panel).
- `Ctrl+C` (twice) interrupts or exits; it is hardcoded and routes through the global keyboard sink, not the keybind registry.

## Built-in Workflows

Four built-in workflows ship with the workflow runtime. `default`, `planner`, `executer`, and `fixer` are registered programmatically from graph factory functions; the files under `examples/abg/` are authoring and parity fixtures. Autopilot is a mode overlay, not a standalone graph. Both CLI invocation paths (interactive `#name` / plain prompt and non-interactive `--workflow` / plain prompt) route through the shared `materializeWorkflow` helper, which folds each declared mode (via `applyMode`) onto the executed graph so overlays like `planner-readonly` land on the live policy-gate, not only on the persisted Mission record. Plain prompts (no `#`) resolve to the materialized `default` fallback without creating Mission/Run records.

- **`default`**: the no-`#` fallback. A strict intent gate requires exactly one of five classes and routes: `trivial` (direct-respond), `exploratory-research` (read-only `research-explore`), `open-ended-planning` (`route-planner`, which routes to `#planner` or a single clarifying question and never implements directly), `explicit-implementation` (memory recall, maturity check, anti-dup and delegation-bias guard, todo planning, delegate wave via `task()` fan-out, per-task critic verification, evidence check demanding concrete verification, supervisor retry loop, final respond), or `ambiguous` (clarify loop). The supervisor carries a 3-strike budget: critic failures and missing-evidence findings route back into delegation until the budget is exhausted, then escalate to a final respond. `delegate-wave` is conditional on `guard.cleared`; the scripted local provider returns `false` for that guard, so offline local runs stop before delegation while capable providers can continue through the declared path. Intent verbalization is deferred. Running `mc` with a plain prompt (no `#` prefix) invokes this workflow.
- **`planner`**: read-only planning. Sticky plan-mode: it plans and never implements (no node declares exec/bash capability). An ambiguity gate (`assess-ambiguity`) routes clear requests through a two-filter stage (`explore-filter` to decide needs-exploration vs direct-draft, then optional `explore` before an interview-loop), unclear requests through best-practice `research` and `adopt-defaults`, and on-the-fence requests through `ask-one-question`. Drafts go to `.mc/drafts/` first; a deterministic `review-plan` critic floor (non-empty, file:line evidence, not a non-answer) is followed by an LLM gap-analysis node (`metis-gap`, `metis.passed` boolean) for stricter refs/QA/acceptance/headers/verification checks. Gap-analysis rejects use a named `metis.rejects` budget of 1 (`routeMetisReject` → revise once or `present-blocked`). A gap-analysis pass enters `dual-review-route` (`routeDualReview`: skip when `intent=clear` and `review_required=false`, else run; missing keys fail-closed to run). When run, `dual-review-wave` fans out bundled `reviewer` + `oracle` via `task()` and aggregates all-approve into `dual.verdict`; REJECT uses `dual.fixes` budget 1 (`routeFixDual` → revise draft with `metis.rejects` reset, or `present-blocked`). Skip or dual APPROVE reaches `approval-gate` on `plan.ready`. Only a plan-ready route commits the scaffold to `.mc/plans/<slug>.md` via `write-plan`. The scaffold output is nine headers, `- [ ]` checkbox todos with references/acceptance/QA/commit, and a Final Verification Wave. The `planner-readonly` mode (applied to the executed graph via `materializeWorkflow`) denies all writes except `.mc/plans/**`, `.mc/specs/**`, and `.mc/drafts/**`. Invoke with `#planner {your planning request}`.
- **`executer`**: plan execution. Entry is `admit-plan`, a plan-admission gate that rejects missing, malformed (missing required scaffold sections), or unapproved plans to a terminal node so no task delegation ever runs on an invalid plan. `parse-plan` is section-scoped: it counts only column-0 checkboxes under `## Todos` / `## TODOs` and `## Final Verification Wave` headings (ignoring Notes, Acceptance Criteria, Evidence, etc.) and surfaces `nextTaskLabel`. Delegation uses a six-section contract (TL;DR, Scope, Todos, Final Verification Wave, Acceptance Criteria, References) and a `delegate-wave` node that fans out per blackboard array item under bounded concurrency via `fanOutKey`. `checkbox-update` enforces verify-before-checkbox discipline: it MUST NOT flip a checkbox on a child "done" claim, must independently verify (tests pass, files modified, diagnostics clean) before flipping `- [ ]` to `- [x]`, and re-reads the plan to confirm the unchecked count decreased. The `final-verification-wave` parallel node aggregates four critic outputs (goal, constraints, tests, code quality) into a single `final.verdict` string (`APPROVE` only if all four approve, otherwise `REJECT`) via `aggregateFinalVerdict`. A `fix-loop` node carries a bounded 3-strike counter: under budget it reopens tasks and reuses the persisted child session id so the retried child resumes with full context; at budget it routes to a terminal `blocked-escalation` node that records which critics rejected and signals for human intervention. Invoke with `#executer {execute plan <slug>}`.
- **`autopilot`**: a mode overlay, not a standalone graph. Prepends six operating directives (certainty before action, scenario before edit, test-driven discipline, QA verification, reviewer separation, completion discipline) to every LLM node and adds a hard policy-gate rule requiring approval before any edit. Applied to any workflow via `modeDeclarations` in the workflow spec. Autopilot is NOT auto-applied to the builtin `default` workflow (it declares no modes); it applies only when a workflow spec declares it in `modes`.

Workflow runtime seams that the built-in graphs rely on: `parseStructuredOutput` persists an `llm` node's `outputKey` value only when the whole output is bare JSON, a whole-output ```json or untagged fence, an exact boolean, or a single-line string. It fails closed (emits a node failure) for unparseable output; `runParallelFanOut` reads a blackboard array via `fanOutKey` and runs one template child per item under wave-bounded concurrency, aggregating `{item,index,result,failed}` into `aggregateKey`; and child `task()` sessions preserve the child's own identity (agent body as system prompt, tool surface with `yield` present and `task` absent, and hard-dropped `subagent`/`workflow`/`network`/`team` capability classes). Retained effectful tools keep their workspace permission callbacks, and child path policies add an independent invocation-time authority check.

Custom workflow migration: an `llm` node with `outputKey` must prompt for one whole, exact representation. Do not request reasoning followed by a final line. The runtime does not extract a last line or supply a default value.

Static `parallel` nodes without `fanOutKey` run declared `children` in waves. A positive integer `config.concurrency` selects the local bound, which defaults to 2; child signals and results aggregate in declaration order, and a rejected child iterator becomes a failure. This is separate from the `fanOutKey` array path. A `race` starts at most four declared children and chooses the earliest valid completion in the current process; authoring more children fails before any branch starts. Cooperative branches drain during cleanup, which defaults to 5000ms and accepts only a positive integer `config.cleanupTimeoutMs` up to 30000ms. Cleanup timeout, iterator return rejection, or iterator `next()`/pump rejection fails the Race even when another competitor produced a valid winner. An ordinary child failure signal may lose without poisoning a valid winner. Arbitrary work is not forcibly terminated. Durable committed-order Race arbitration is deferred.

Deferred (not claimed as implemented):

- Model-specific per-model persona prompt variants are deferred; reasoning effort routes through the `provider/model#variant` syntax instead.
- Intent verbalization before routing is deferred; the default gate requires a strict single-line class output so prose cannot be mistaken for structured state.
- Wholesale upstream agent harness hook replication (pre/post turn, tool, session hooks) is deferred; parity is reached through ABG graph + policy-gate + mode-overlay, not a hook bus.
- The planner draft-state runtime (parity matrix row 8) is implemented: the generic LLM `outputKey` seam writes `plan.drafted`, `metis.passed`, `dual.route`/`dual.verdict` (via dual-review-route + parallel all-approve), and `plan.ready`; the deterministic review-plan critic writes and routes on `critic.passed` as the approve-biased floor; the LLM gap-analysis node (`metis-gap`) is the stricter gap analysis; high-accuracy dual-review (bundled reviewer+oracle, `dual.fixes` budget 1) runs after a gap-analysis pass when required; resume-gate and interview-loop pure helpers are wired. See `docs/abg-reference-parity-matrix.md` row 8 detail. `plan.approved` remains a declared critic-adjacent key, not the routing authority.

Non-interactive equivalent: `mc run --workflow <name> "<prompt>"` (mutually exclusive with `--graph`). The model can also self-invoke a workflow through the `workflow(name, prompt)` tool, which resolves the name via the workflow registry and returns a `started` or `not_found` status.

Discovered workflows are listed to the model in an `<available_workflows>` system-prompt block. Custom workflows follow the same `*.workflow.json` or `*.workflow.jsonc` format and the same three-scope first-wins discovery as skills (global config dir, `.mctrl/workflows/`, `.agents/workflows/`).

## Agent System

The agent system discovers, validates, and resolves deployable subagents that the `task()` tool spawns as child coding agents. Agents are markdown files with YAML frontmatter, discovered across four builtin scopes plus nine cross-harness importers, first-wins by name. Discovery, parsing, the by-name registry, recursion compatibility metadata, approval tiers, and the default spawn function are implemented and test-covered. The default spawn function (`createChildGraphSpawnFn`) runs a bounded coding-agent graph with the child's own identity (agent body as system prompt) and the pre-built child tool surface (`yield` present; `task` and `job` absent; `subagent`/`workflow`/`network`/`team` capability classes hard-dropped) when a `resolveSdkModel` is provided; it rejects only in pure-test mode without a real provider.

Agent discovery scopes (first-wins by name):

- Project: `<workspace>/.mctrl/agents/`.
- User: `<config-dir>/agents/`.
- Plugin: configured `additionalDirs`.
- Bundled: runtime agents shipped with `@mission-control/core` (`deep`, `quick`, `reasoner`, `designer`, `explore`, `oracle`, `librarian`, `planner`, `reviewer`).

Cross-harness importers (priority 50, lower than the builtin 100) scan each harness's own agent directories and import what they find: Claude Code, Cursor, Codex, Gemini, Cline, Windsurf, VS Code, GitHub Copilot, and OpenCode. A mission-control agent always wins a name conflict over an imported one. Discovery is discovery-safe: symbolic links are skipped, paths on the shared read-tool denylist are pruned, files above the 64KB size bound are skipped, the agent count is capped at 256, and discovery never throws. Broken files emit diagnostics and are skipped rather than failing the run.

Agent definition format:

- Required frontmatter: `name`, `description`.
- Required body: a non-empty markdown body, parsed into the agent's `systemPrompt`.
- Optional frontmatter: `tools` (CSV string, array, or object map of enabled tools), `spawns` (array or `'*'`), `model` (string or `{providerID, modelID}`), `thinkingLevel` (`low`/`medium`/`high`/`xhigh`), `tier` (`read`/`write`/`exec`), `maxTurns`, `recursion` (preserved compatibility metadata; `-1` retains an imported unlimited-depth declaration but does not grant nested task authority), `role`, `pathPolicies`, `autoloadSkills`, `blocking`.
- The schema is strict; unknown frontmatter keys are rejected.

Managing agents in interactive chat:

- `/agents` opens the agent control dashboard in the TUI (or prints the discovered-agents list as text on a non-TTY).
- `/agents list` prints the discovered-agents list as text with source, model, and tier.
- `/agents <name>` shows full details for one agent.
- `/agents reload` re-runs discovery without restarting the chat.
- `/agents disable <name>` disables a single agent so it cannot be spawned via `task()`.
- The reserved subcommands `dashboard`, `list`, `reload`, and `disable` shadow same-named agents; use `mc agents show <name>` to inspect a colliding agent.

Spawning child agents:

- `task()` delegates a bounded sub-task to a child coding agent. The single form takes `{ agent: '<name>', assignment: '<prompt>' }`; the batch form takes `{ tasks: [{ agent, assignment, role? }, ...] }` and runs up to four children concurrently per wave.
- The child tool surface is structurally restricted: every production child loses both `task` and `job`, gains `yield` for result submission, hard-drops `subagent`, `workflow`, `network`, and `team` capability classes, and drops tools whose capability classes are denied by the derived path policies (so a `deep` agent keeps write/bash while a `planner` loses them).
- The interactive and non-interactive CLI roots are not agent declarations and have no session-scoped `PolicyEffectRuleSet`. Their children are constrained by the selected category and child agent `pathPolicies`. An embedding that supplies a real parent `AgentDefinition` through the public core factory also forwards that parent's `pathPolicies` denies. Workspace `PermissionRule` entries continue to gate `task()` and retained tool calls, while workflow mode policies remain graph-scoped; neither is converted into child path policies.
- The child runs under its own identity: the agent body becomes the child system prompt (the parent persona is never injected), and the spawned graph injects that prompt into its `llm-actor` node. The yielded result (captured via the `yield` tool's callback) becomes the child's output; missing yields produce a bounded degraded salvage summary and failed status.
- Child model precedence is exact `mctrl/task` inheritance first; otherwise a named agent override wins, then concrete or role-based `agent.model`, then the active parent model, then the session default.
- Production child sessions never receive `task` or `job`, and no `recursion` value re-enables nested routing. `canSpawnAtDepth`, `RecursionTracker`, `DEFAULT_MAX_RECURSION_DEPTH`, and `HARD_RECURSION_CAP` remain standalone compatibility utilities, not production `task()` authority.
- Approval is layered: the parent `task()` invocation is permission-gated, and retained effectful child tools keep their original workspace permission callbacks. Category restrictions and derived `AgentDefinition.pathPolicies` independently filter and reject invocations, while structural filtering removes `task`/`job` and hard-drops `subagent`/`workflow`/`network`/`team`. The standalone approval-tier resolver is separate metadata and is not a source of inherited child rules.
- A child resume requires an idle or parked child owned by the same parent and a matching SHA-256 `authorityFingerprint` digest. The digest covers the effective child authority, so a changed parent surface, category, policy, child definition, model, or system prompt rejects the resume.

Adopted child agents run under an idle-to-parked-to-revived lifecycle (default 7 minute idle TTL) and a concurrency-bounded async job manager. The live managers still coordinate in memory, while the SQL task runtime mirrors visible runtime agent refs, async job handles, foreground subagent waits, and child-session relation rows into the shared local `mission-control.db` session store.

## Model Provider Selection

The CLI accepts provider/model selection for demo and coding-agent runs. The catalog combines the scaffold `local` provider with the OpenCode/Models.dev provider credential catalog. Runtime execution is implemented for the deterministic local provider, OpenAI Responses, Anthropic Messages, Google Gemini, and the OpenAI-compatible adapter family for OpenRouter, Groq, DeepSeek, Mistral, and ZAI Coding Plan. Other vendored providers can be configured for credentials and catalog selection but do not have execution adapters yet.

```bash
pnpm dev:cli -- --no-tui --provider local --model local-echo
pnpm dev:cli -- --json --model local/local-echo
mc auth login --provider local --api-key <key>
mc auth login --provider anthropic --api-key <key>
mc auth login --provider openai --method oauth-headless
mc auth login --provider github-copilot --method oauth
mc auth login --provider xai --method oauth
mc auth login --provider cloudflare-ai-gateway --credential apiToken=<token> --credential accountId=<account> --credential gatewayId=<gateway>
mc auth login --provider amazon-bedrock --credential region=<region> --credential accessKeyId=<key-id> --credential secretAccessKey=<secret>
mc auth login
mc auth list
mc auth logout --provider local
mc models local
```

Installed `mc` provider-backed examples should use isolated data and auth paths for repeatable local tests:

```bash
MCTRL_DATA_DIR=/tmp/mctrl-demo-data MISSION_CONTROL_AUTH_FILE=/tmp/mctrl-demo-auth.json mc auth login --provider local --api-key local_test_key
MCTRL_DATA_DIR=/tmp/mctrl-demo-data MISSION_CONTROL_AUTH_FILE=/tmp/mctrl-demo-auth.json mc run "summarize this repository" --session session_demo --jsonl --provider local --model local-echo
MCTRL_DATA_DIR=/tmp/mctrl-demo-data MISSION_CONTROL_AUTH_FILE=/tmp/mctrl-demo-auth.json mc session replay session_demo --jsonl
```

The vendored Models.dev snapshot is generated from `https://models.dev/api.json` and is stored under `packages/config/src/generated/`. Refresh it with `node --experimental-strip-types scripts/sync-models-dev-catalog.ts`. Normal CLI commands use the vendored file only; there is no runtime fetch to Models.dev.

`mc auth login` supports credential setup for every vendored OpenCode provider. Single-secret providers can use `--api-key <key>` as an alias for their primary secret. Multi-field providers use repeatable `--credential FIELD=VALUE` flags. OAuth-capable providers expose OpenCode-style `--method` choices: OpenAI supports browser and headless ChatGPT OAuth plus API key login, GitHub Copilot supports OAuth device login plus API key login, and xAI supports SuperGrok / X Premium+ OAuth device login plus API key login. Missing credential fields are resolved from explicit CLI values, matching environment variables, existing stored values, and interactive prompts, in that order.

`mc auth login` can prompt interactively for provider, auth method, and credential fields when flags are omitted. Stored credentials configure the default provider/model for subsequent CLI runs, including coding-agent prompts, so a later `mc --no-tui` can use the saved default when no `--provider` or `--model` flag is passed.

Credential storage defaults to `$XDG_DATA_HOME/mission-control/auth.json` or `~/.local/share/mission-control/auth.json`. Set `MISSION_CONTROL_AUTH_FILE=/tmp/mctrl-auth.json` to use a specific auth file for tests, demos, or isolated workspaces.

API keys, OAuth tokens, and multi-field provider credentials are stored as plaintext JSON in that auth file. This scaffold does not use encrypted OS keychain storage yet; this is not encrypted keychain storage.

`mc models [provider]` lists scaffold and vendored provider models and shows whether each provider has a configured credential. Command output masks credentials and does not print raw API keys or raw multi-field secret values.

Interactive `/model` choices are narrower than `mc models`: they first require a logged-in provider, and API-key credentials for supported providers can call the provider's model-list API at chat startup. When discovery succeeds, `/model` intersects the live provider model IDs with the vendored catalog before showing, searching, or accepting a model selection. OAuth credentials, unsupported providers, failed requests, and malformed responses fall back to the vendored models for that logged-in provider.

The desktop demo control surface exposes provider/model controls, an API key credential field, credential configured/missing state, and the active selection in the status area and event log. The Tauri desktop client saves and lists API-key credentials through the same auth file used by the CLI, and desktop prompt/resume/approval commands route through the core provider factory.

Provider capability statuses separate executable adapters from catalog-only entries. `local`, `openai`, `anthropic`, `google`, `openrouter`, `groq`, `deepseek`, `mistral`, `zai-coding-plan`, and `xai` can run coding-agent prompts through implemented adapters. Other catalog entries can be `model-discovery-only`, `auth-only`, or unsupported for prompt execution until they have adapter tests and an executable integration proof. Provider-backed coding commands require an executable adapter proof before a provider can run.

The legacy no-prompt demo uses provider/model selection only as observable event metadata and does not call an LLM. Coding-agent prompt runs use executable provider adapters or the AI-SDK graph resolver and can call real providers when configured.

credentials are used by implemented provider adapters only. For providers without execution adapters, credentials are used for scaffold configuration only. The OpenAI Responses adapter is implemented behind stored provider credentials, defaults requests to `store: false`, and the Anthropic, Google Gemini, and OpenAI-compatible adapters use the same provider-neutral streaming and redaction boundary. Raw secrets stay out of protocol events, JSONL logs, CLI output, desktop props/state snapshots, and error messages. Mission Control does not implement real LLM provider execution for providers without an adapter.

The catalog also exposes the local provider/model variant `local/local-echo/default`. For the deterministic local provider that variant stays metadata, since there is no real request body to shape. Real provider variants, covered in Model Variants below, map into the provider request body.

## Model Variants

A model selection can carry a reasoning or thinking variant using the `provider/model#variant` syntax. `anthropic/claude-sonnet-4-6#thinking-high` requests high-effort extended thinking on that Anthropic turn, and `openai/gpt-5#reasoning-high` asks OpenAI for high reasoning effort. Both the `/model provider/model#variant` chat command and the `--model provider/model#variant` flag accept the variant suffix.

Per-provider variant support:

| Provider | Adapter | Variant IDs | Request field | Model gate |
| --- | --- | --- | --- | --- |
| `openai` | OpenAI Responses | `reasoning-minimal`, `reasoning-low`, `reasoning-medium`, `reasoning-high`, plus `reasoning-none` and `reasoning-xhigh` on `gpt-5.4` and `gpt-5.5` | `reasoning.effort` | reasoning-capable model regex |
| `anthropic` | Anthropic Messages | `thinking-off`, `thinking-low`, `thinking-medium`, `thinking-high` | `thinking.budget_tokens`, plus a paired `max_tokens` override that keeps `budget_tokens` below `max_tokens` | thinking-capable Claude model regex |
| `google` | Google Gemini | `thinking-low`, `thinking-medium`, `thinking-high` (Gemini 2.5 Pro and Flash only) | `generationConfig.thinkingConfig.thinkingBudget` | Gemini 2.5 Pro/Flash regex, excludes flash-lite, image, tts, and nothink variants |
| `openrouter` | OpenAI-compatible | `reasoning-low`, `reasoning-medium`, `reasoning-high` on reasoning-capable models | `reasoning.effort` | prefixed reasoning-model regex |
| `groq` | OpenAI-compatible | `reasoning-none`, `reasoning-low`, `reasoning-medium`, `reasoning-high` on reasoning models | `reasoning_effort` | reasoning-model regex |
| `mistral` | OpenAI-compatible | `reasoning-high` on `mistral-small-2603`, `mistral-small-latest`, and `mistral-medium-2604` only | `reasoning_effort` | exact model-ID list |
| `zai-coding-plan` | OpenAI-compatible | `reasoning-high`, `reasoning-max` on GLM 5.2+ (base, air, turbo; vision excluded) | `thinking.type: "enabled"` plus `reasoning_effort` (`high`/`max`) | GLM 5.2+ regex, excludes vision SKUs |

Numeric variant budgets: Anthropic `thinking-low` sets `budget_tokens` to `8000` with `max_tokens` `9024`, `thinking-medium` uses `16000` and `17024`, `thinking-high` uses `32000` and `33024`. Gemini `thinking-low`, `thinking-medium`, and `thinking-high` set `thinkingBudget` to `2048`, `8192`, and `24576`. The Gemini high value is the safe cross-model cap; Flash tops out at `24576` and Pro at `32768`. ZAI GLM-5.2 accepts only `high` and `max` as `reasoning_effort` values; each co-emits `thinking:{type:"enabled"}`.

Silent-drop policy: a variant that is not configured for the selected model is dropped at the provider boundary with no error. The runtime looks up the model's catalog entry, and when that entry has no matching variant preset the reasoning or thinking field is omitted from the request body. So `openai/gpt-4o-mini#reasoning-high` and `google/gemini-2.0-flash#thinking-high` both send a plain request with no reasoning or thinking field. A stale selection never turns into a hard failure.

Each provider family owns its variant mapper. The mapper is a private function in that provider's `<provider>-request.ts` file, gated by an `isConfigured<Provider>Variant` catalog lookup that mirrors `openAIReasoningForVariant` and `isConfiguredOpenAIVariant` in `openai-responses-request.ts`. Presets and model-capability matchers live together in `packages/config/src/model-variant-presets.ts`.

Deferred follow-ups:

- Gemini 3.x uses a different vocabulary (`thinkingLevel` as an enum, not a token budget). Only 2.5 `thinkingBudget` is supported for now.
- The agent-frontmatter `thinkingLevel` field does not yet bridge to a variant ID. That is a separate concern.
- The AI-SDK graph path (`ai-sdk/model-resolver.ts`) ignores `variantID`. It is tied to the graph-runner cutover.
- DeepSeek intentionally returns no variants in v1. `deepseek-reasoner` is always-on reasoning.
- Mistral reasoning is pinned to the dated IDs `mistral-small-2603` and `mistral-medium-2604`, plus `mistral-small-latest`. `mistral-medium-latest` is intentionally not whitelisted, so pick the dated ID for reasoning.

## Configuration

Mission Control separates configuration (how MCP servers and environment-variable allowlists are declared) from data (sessions, auth, trust). Configuration lives in the config directory and the project workspace; data lives in the Mission Control data directory and is never selected by `--profile`.

### Config directory vs data directory

- Config directory: `MCTRL_CONFIG_DIR` overrides it directly (used as-is). Without an override, the platform application-config directory joined with `mission-control` is used (`$XDG_CONFIG_HOME/mission-control` or `~/.config/mission-control` on Linux, `%APPDATA%\mission-control` on Windows, `~/Library/Application Support/mission-control` on macOS). The global user config and profile files live here.
- Data directory: `MCTRL_DATA_DIR` overrides it; otherwise the platform application-data directory is used. Session data, the auth file (`MISSION_CONTROL_AUTH_FILE`), and the project trust store (`trust/projects.json`) live here. The data directory is independent of `--profile`.

### Global user config: `config.json`

The global user config file is `config.json` in the config directory. It declares user-scope MCP servers and the environment-variable expansion allowlist (`mcp_env_allowlist`). A `${VAR}` reference in a server `command`, `args`, or `headers` is expanded only when `VAR` is listed in `mcp_env_allowlist`. User-scope `mc mcp add` and `mc mcp remove --scope user` rewrite this file.

The same user config can enable the approval-gated `browser` tool for an externally managed Chrome. Configure exactly one endpoint form:

```json
{
 "browser": { "browserURL": "http://127.0.0.1:9222" }
}
```

Use `browserWSEndpoint` instead to provide Chrome's direct `ws://` or `wss://` DevTools browser endpoint. The two keys are mutually exclusive. Mission Control never reads browser endpoints from project `.mcp.json`, never downloads or launches Chrome, and disconnects without terminating the external Chrome process. The tool is advertised only when the selected global config or profile contains a valid browser endpoint; invocation still requires canonical workspace trust and network approval before it connects.
Browser navigation accepts only `http://` and `https://` targets. Configured endpoint credentials, paths, and query values are hidden in approval records and connection errors; navigation credentials and query values are also hidden in approvals and returned URLs.

### Local memory tools

Memory tools are off by default. Set the selected global config or profile to the local backend to advertise `retain`, `recall`, `reflect`, `memory_edit`, `learn`, and `manage_skill`:

```json
{
 "memory": { "backend": "local" }
}
```

All six tools in one production registry share one in-process memory backend. This backend is process-local and non-durable: a rebuilt registry starts empty, process exit loses its contents, and no SQLite store, vector index, remote service, or cross-session persistence is provided. The recognized `mnemopi` and `hindsight` values are deferred and advertise no memory tools; `off` and an absent `memory` block are also silent.

### Project-local config: `.mcp.json`

The project-local config file is `.mcp.json` at the resolved workspace root. It declares project-scope MCP servers and is intended to be committed to the project. Production tool registries read and merge this file only when the canonical project trust store already marks the workspace as trusted; missing, denied, corrupt, or failed trust lookups leave project servers inert. Trusted project servers merge after the selected global config and override by server name. User-scope MCP remains active independently of workspace trust. A profile does not affect `.mcp.json`; a sibling `.mcp.<profile>.json` or `.mcp.<profile>.jsonc` is ignored.

### Config profiles: `--profile <name>`

`--profile <name>` is a long-only flag (there is no `-p` alias for profile) that selects a user-scope config profile for the current run. It is purely a global config file selector: it changes which user config file is read, nothing else.

Filename precedence in the config directory (first existing file wins; there is no fallback to `config.json`):

1. `mission-control.<profile>.jsonc`
2. `mission-control.<profile>.json`
3. `config.<profile>.jsonc`
4. `config.<profile>.json`

When `--profile dev` is used, the selected profile file replaces `config.json` as the global config input; there is no fallback. The base `config.json` is not read when a profile is selected, so the profile's MCP servers and allowlist entirely replace the base config.

JSONC support: `.jsonc` profile files may contain `//` line comments and `/* */` block comments, which are stripped before parsing. Trailing commas are not supported and produce a parse error.

Profile-not-found behavior: if no candidate file exists, the runtime surfaces a clear error naming the profile and the four candidate paths, and does not silently fall back to base config.

Profile name rules: the name must match `^[a-z0-9][a-z0-9_-]{0,63}$` (lowercase letters, digits, `_`, `-`; must start with a letter or digit; max 64 characters). An invalid value is rejected with a message naming the offending value.

User-scope writes with a profile: `mc mcp add` / `mc mcp remove --scope user --profile dev` rewrite an existing profile candidate (preserving its format) or create `mission-control.<profile>.jsonc` when none exists. `--scope project --profile dev` ignores the profile and still writes `.mcp.json`.

`--profile` does not change the data directory, auth file (`MISSION_CONTROL_AUTH_FILE`), session database, trust store, skills, workflows, agents, keybinds, or project `.mcp.json`. It is purely a user-config-file selector.

Example:

```bash
mc mcp list --profile dev
mc run "summarize this repository" --profile dev --session session_dev --jsonl
```

## Coding Agent Runtime

The coding-agent MVP now includes durable chat sessions, provider streaming, approval-gated local tools, replay projections, bounded graph orchestration, CLI chat, core desktop approval services, project workspace trust, permission profiles, an expanded coding-agent tool set, session tree navigation, manual compaction, and session export/import.

For release-adjacent local verification, `pnpm smoke:coding-agent-built-dist` runs the built-dist coding-agent smoke against a temporary trusted workspace and temporary auth/data paths, prints the captured command output plus the temp session database path, and fails if either the blocked replay preview or the resumed replay emits diagnostics. This is intentionally a built-dist coding-agent smoke, not a tarball artifact smoke; Todo 18 owns the tarball artifact smoke.

### Session Stop Contract

`mc session stop <session-id>` stops current work without making the session terminal. The default scope is the selected session plus its canonical descendants. `--only` limits the operation to the selected session. `--child-only` recursively stops descendants while leaving the selected session running. The two scope flags are mutually exclusive. A terminal selected session is a no-op but remains traversable, so active descendants can still be reached.

The stop command uses owner IPC for a live session. The default timeout is `15000ms`; accepted values are integer `ms`, `s`, or `m` durations from `100ms` through `300000ms`. Each command prints one aggregate stdout line, never per-session records. Exit `0` means every requested change completed or was a no-op, exit `1` means a runtime or partial failure, and exit `2` means invalid arguments. The tested summaries are:

| Case | stdout | Exit |
| --- | --- | --- |
| Full success or no-op | `Stopped C/T session(s) (I already idle, A already terminal).` | `0` |
| Child-only scope without descendants | `No sessions to stop.` | `0` |
| Partial or runtime failure after targeting | `Stopped C/T session(s); F failed.` | `1` |
| Missing root | `Failed to stop sessions: session_not_found.` | `1` |
| Unstable selected hierarchy | `Failed to stop sessions: unstable_session_tree.` | `1` |
| Unexpected internal error | `Failed to stop sessions: internal_error.` | `1` |

Invalid scope flags or durations write the exact usage line to stderr and exit `2`. The stop surface has no JSON result mode. `T` is the aggregate `C + I + A + F`; `session(s)` is literal.

Session storage:

- `MCTRL_DATA_DIR` overrides the Mission Control data directory.
- Without `MCTRL_DATA_DIR`, the local session database uses the platform application-data directory.
- New authoritative session event/replay writes use the local libSQL database at `<data-dir>/mission-control.db`, shared with persistent memory storage through the current schema initializer. The path is canonicalized before it is hashed into the database identity used by leases and owner IPC.
- Each canonical database file has one leased libSQL client and Drizzle handle per process. Separate processes own separate clients for the same file.
- Every in-process mutation, including schema initialization, enters the explicit file-scoped write lane; Drizzle does not provide this serialization.
- File-backed opens require `journal_mode=WAL`, `synchronous=NORMAL`, and a 5000 ms cross-process busy timeout before use.
- Runtime startup opens only the unified database; it does not probe or automatically import prior SQL stores. Normal session-store opens automatically discover `sessions/*.jsonl`, import them idempotently through `legacy_session_imports`, and leave the source files unchanged. They pass `includeRunSources: false`, so `.mc/runs/*.json` files do not auto-import.
- The product opener opens `<data-dir>/mission-control.db` directly. An unavailable optional libSQL native binary may fall back to in-memory working memory, but an accepted path that raises `LocalDbConfigError` or `LocalDbInitializationError`, including WAL refusal, is fatal instead of silently falling back.
- Runtime coordination SQL for session input delivery, Mission/Run records, context epochs, runtime agents, async jobs, and relation rows uses the same local `<data-dir>/mission-control.db` path as the public session projection.
- Production `approval`, `user_input`, and foreground `subagent` waits surface through the public `mission-control.db` session-list/read path.
- `session_events` owns session, run, approval, and input history plus event-derived projections. `mission_runs` owns mission work, and live jobs plus their `async_jobs` mirror own job work. A session reaches idle only when all three authorities are quiescent.
- A workflow Run with status `blocked` is nonterminal and has no `terminalReason`. Its reason remains event-level until typed Run wait metadata exists, and it resumes only through an explicit lifecycle action such as an approval decision.
- Legacy JSONL logs can still live at `sessions/<session-id>.jsonl` and are import/export compatibility artifacts. Import never deletes or rewrites them.
- JSONL compatibility logs contain durable event envelopes with stable event ids, sequence numbers, causation/correlation ids, and replay cursors.
- The SQLite/libSQL session data model, table responsibilities, indexes, compatibility import, and explicit export behavior are documented in [`docs/session-data-model.md`](docs/session-data-model.md).
- Remote Turso is out of scope for session storage: there are no remote URLs, auth tokens, replica configuration, or network sync steps.
- Use --json for transient JSON Lines rendering and --jsonl for JSON Lines rendering plus replayable session persistence.
- Launching the interactive TUI without an explicit `--session <id>` creates no session artifacts until the first prompt turn; non-interactive `--jsonl` runs and an explicit `--session <id>` still create a SQLite session eagerly.

Workspace selection:

- `--workspace <path>` pins the target project directory the coding agent operates on.
- `MCTRL_WORKSPACE` env var is the equivalent for tests/scripts that want to avoid command-line flags.
- Without either, the runtime walks up from `process.cwd()` looking for `.git` or a workspace `package.json`.
- The interactive StatusBar shows the resolved workspace's basename plus the current git branch.

Provider path:

- The deterministic `local/local-echo` provider is available for offline tests and demos.
- The OpenAI Responses adapter is implemented for real provider turns when OpenAI credentials are configured.
- Anthropic Messages, Google Gemini, and OpenAI-compatible adapters are implemented for `anthropic`, `google`, `openrouter`, `groq`, `deepseek`, `mistral`, `zai-coding-plan`, and `xai` when credentials are configured.
- Live provider smoke tests are opt-in only and are not required for CI.
- Unsupported providers remain catalog/auth entries until an execution adapter is added.
- Providers without execution adapters remain catalog/auth entries and must not be documented as executable.

Approval lifecycle and safe tools:

- Approval events use `approval.requested`, `approval.updated`, `approval.resumed`, and `approval.blocked`.
- Effectful tools do not execute until approval state is `approved`.
- The read-only safe tool set is `repo.read`, `repo.list`, and `repo.search`; `file.patch` and `command.run` are approval-gated effectful tools.
- Read aliases `read`, `ls`, `grep`, and `find` mirror the read-only tools with the same workspace path guards and permission checks.
- Reference repositories under `temp/ref-repos` are planning evidence only.
- `repo.read`, `repo.list`, and `repo.search` deny `temp/ref-repos` by default, along with generated and cache directories.
- Runtime prompts and tool instructions must not load AGENTS.md or other instructions from reference repos.
- `file.patch` enforces workspace containment, symlink escape rejection, patch bounds, dirty tracked-file checks, and before/after diff events.
- `command.run` uses a fixed verification-harness allowlist, non-interactive execution, timeouts, output caps, and command lifecycle events.

Workspace trust:

- The project trust store lives at `trust/projects.json` under the Mission Control data directory.
- `/trust` marks the workspace as trusted; `/trust deny` denies project-local resources; `/trust reset` clears the decision.
- `bash.run`, `eval`, `file.edit`, and `file.write` require a trusted workspace before registration. Project-local `.mcp.json` servers also require pre-existing workspace trust before config loading or connection; user-scope MCP does not.
- Read-only tools (`repo.read`, `repo.list`, `repo.search`, `read`, `ls`, `grep`, `find`) work regardless of trust but still enforce workspace path guards.
- Trust decisions persist across sessions and are normalized by resolved workspace root path.

Permission profiles:

- Built-in rules allow `read` always, and ask for `edit`, `write`, `patch`, and `bash` by default.
- Interactive replies support `once` (allow this request only), `always` (allow all future matching requests), and `deny` (block the request).
- `always` replies can persist to the permission rule store scoped by permission kind, glob pattern, and workspace root.
- Noninteractive `--no-tui` and `--json` runs use the pending-approval-block behavior: effectful tools emit `approval.blocked` and the run enters `blocked_on_approval` instead of executing without consent.
- Permission rules use glob patterns scoped by permission kind (`read`, `edit`, `write`, `patch`, `bash`) and optional workspace root.

Coding-agent tool set:

- Read-only: `repo.read`, `repo.list`, `repo.search`, plus aliases `read`, `ls`, `grep`, and `find`.
- Tagged and path discovery reads: `repo.read.tagged` supplies anchors for `hashline_edit`, while `glob` discovers workspace files under the same containment and denylist boundary.
- Exact replacement: `file.edit` replaces exact text in an existing file, with occurrence counting and diff events.
- Full create/replace: `file.write` creates or replaces a file with full text content, with optional parent-directory creation and binary-content refusal.
- Unified diff: `file.patch` applies unified diffs with workspace containment and dirty-file checks.
- Verification harness: `command.run` uses a fixed allowlist, non-interactive execution, timeouts, and output caps.
- Trusted bash: `bash.run` runs non-interactive bash with strict command-line parsing, an environment variable allowlist, cwd containment within the workspace, a 30-second timeout, 64KB output cap, single-invocation concurrency, and secret redaction.
- Trusted eval: `eval` executes JavaScript or Python cells in a local host-user runtime with a read-only workspace bridge. It requires one explicit bash-class approval before creating the per-invocation runtime; Python `-I` is isolated startup mode, not a security sandbox.
- External GitHub reads: `github` is advertised only when the canonical workspace trust check passes and the local `gh --version` probe succeeds. Missing `gh` or missing trust leaves the tool unadvertised.
- Generated media: `generate_image` is advertised only when its Gemini, OpenAI, or xAI environment credential resolver succeeds; `tts` is advertised only for an xAI environment credential. Their outputs contain local file paths rather than inline media and do not imply managed or persistent media storage.
- Vision inspection: `look_at` and `inspect_image` use an execute-time credential boundary. They remain advertised without a vision credential, but invocation fails non-retryably before provider I/O when the OpenAI, Anthropic, Gemini, OpenRouter, or ZAI credential chain is empty. `ssh` remains unadvertised even with configured hosts because the CLI has no production PTY transport.
- `file.edit`, `file.write`, `file.patch`, `command.run`, and `bash.run` require approval before executing. `eval` also requires approval before executing.
- `bash.run` additionally requires a trusted workspace. `eval` has the same trust requirement.
- File mutations serialize through a shared workspace mutation queue with pre-approval and post-approval target revalidation to prevent TOCTOU workspace escape.
- The CLI is the primary host for the broad coding-agent registry. Config-, credential-, transport-, callback-, and manager-gated families appear only when their production dependencies are available; the desktop intentionally uses the smaller subset documented below.

Skills + MCP:

- Skills are implemented: `SKILL.md` files are discovered (global, project `.mctrl/skills`, project `.agents/skills`), listed to the model in an `<available_skills>` system-prompt block, and loaded on demand via the `skill` tool or the `$name [args]` chat prefix. Skill bodies are framed as reference DATA, never as trusted policy.
- MCP tools are implemented: user-scope servers and trusted-workspace project servers (stdio or remote) connect eagerly at session start, surface their tools as namespaced `mcp__<server>__<tool>` merged with the built-in registry, and disconnect cleanly on stop. Missing, denied, corrupt, or failed workspace trust prevents project config loading and connector/process creation, while user config remains independent. Before every project-scope invocation, the runtime re-reads canonical workspace trust; revocation or lookup failure rejects before approval or server handling and quarantines only project connections. User-scope tools remain connected. Each surfaced MCP tool still requires its invocation-time network approval. A crashing or hanging server is skipped at its deadline with a warning so the run continues without it. Arbitrary MCP server output is framed as untrusted DATA and capped before reaching the model; expanded env/header secret values are redacted from tool output, errors, and persisted session events.
- web tools (glob, todowrite, webfetch) are implemented: `glob` and `todowrite` are read-class (no approval), `webfetch` is network-class and approval-required on both flat and graph paths.
- subagent orchestration via the task tool is implemented: `task` delegates a bounded sub-task to a child coding agent whose tool surface is structurally restricted (no nested `task`/`job`, no network, no `mcp__*`).
- A real tool-calling provider is required for general agentic behavior. The default `local/local-echo` provider only emits scripted `file.patch` and optional `command.run` calls for `deterministic patch` test prompts; arbitrary skills, MCP tools, and coding-agent tool choices require a capable provider.
- LSP integration transport is deferred: the `lsp` tool seam exists and registers only when a real `LspClient` is injected (default runs omit it); a stdio JSON-RPC language-server transport is follow-up work.

Graph limits:

- graph node concurrency defaults to 2.
- provider parallel tool calls default to 4.
- shell/process concurrency defaults to 1.
- node retries and graph loops are bounded by explicit runtime limits.

Noninteractive JSON/JSONL run states:

- `mc run "<prompt>" --no-tui` and `--json`/`--jsonl` modes run a single prompt through the coding-agent path with the full tool set.
- Run receipts settle as `completed`, `failed`, `interrupted`, or `blocked_on_approval`.
- `blocked_on_approval` means the run paused for an approval decision and can be resumed with `/continue` in interactive mode or by recording an approval decision in the durable session.
- `--jsonl` persists a replayable durable session; `--json` emits transient JSON Lines without persistence.
- Noninteractive runs do not auto-approve effectful tools; they block and wait for external approval.

Session export, import, compaction, deletion, and stats:

- `mc session export <id> <path>` writes a checksummed session archive file with manifest, events, and SHA-256 checksum.
- `mc session import <path>` imports a session archive into a new durable session.
- `mc session list` lists sessions with lifecycle status, event counts, message counts, and trust status.
- `mc session status [session-id]` prints the current session status as plain text. With an id, it prints one stable line for that session. Without an id, it lists known sessions in the same sort order as `mc session list`. Awaiting reasons are `approval`, `user_input`, or `subagent`.
- `mc session show <id>` shows the session snapshot, approvals, tool outcomes, coding steps, and diagnostics.
- `mc session replay <id> --jsonl` replays durable events and coding steps as JSON Lines.
- `mc session delete <id>` deletes a session and its canonical descendant subtree. Each session's SQLite rows, compatibility JSONL log if present, and projection rows are removed. A guarded delete accepts `--expected-tree-token <sha256>` and rejects a changed subtree or any live lease. Ground Control uses guarded, non-force deletion only after confirmation.
- `/compact` in interactive chat summarizes older session history into a durable compaction boundary event, reducing replay context while preserving the session tree.

Desktop scope:

- The desktop reads durable local session projections, renders timeline/graph/session projections, and shows patch/test output.
- `packages/core` contains desktop command services for prompt, queue follow-up, steer, interrupt, resume, and approval decisions.
- desktop Tauri write commands call the core desktop session command service through the Rust shell bridge and return real `eventsWritten` counts.
- desktop Tauri credential commands save and list API-key credentials through the shared auth file, and restarted prompt/resume/approval commands reuse the session's persisted provider selection.
- The desktop registry is deliberately limited to operations reconstructible from the workspace plus tool-call arguments: `repo.read`, `repo.list`, `repo.search`, `read`, `ls`, `grep`, `find`, `repo.read.tagged`, `glob`, `file.edit`, `file.write`, `file.patch`, `hashline_edit`, and `command.run`. Workspace reads remain read-only and do not invent an approval prompt.
- Desktop file mutations and `command.run` still block before execution. Approval settlement rebuilds the same subset in a fresh registry and re-executes only the persisted tool call whose request id and action match the approved record; workspace containment, dirty-file checks, and post-approval target revalidation remain active.
- Session-bound facilities remain CLI-primary and are not desktop approval re-execution capabilities: staged preview (`ast_grep` rewrite plus `ast_edit` / `resolve`), `job`, `monitor_*`, `interactive_bash`, `shell.session`, `ssh`, `checkpoint` / `rewind`, and `plan_exit`. `lsp` and `lsp_rename` also remain absent because a fresh desktop registry has no live LSP client and cannot reconstruct the server-produced workspace edit from tool-call arguments alone.
- This bounded subset does not claim full desktop effectful-tool parity. Adding manager-, callback-, or transport-backed tools requires a shared-lifecycle redesign rather than another fresh approval registry.
- The desktop shell never mutates files directly; permission enforcement and file/command effects stay in `packages/core`.

Sidecar status:

- Sidecar protocol v1 negotiates `task.run` by default.
- Feature-flagged sidecar protocol v2 negotiates `task.cancel` plus `task_failed` and `task_cancelled` wire responses only when core enables `enableSidecarProtocolV2` and the sidecar runs with `MCTRL_SIDECAR_V2=1`.
- The runtime emits `native.status` and `native.warning` to distinguish `unknown`, `native`, `unavailable`, and `mock` sidecar states.
- file.patch and command.run stay on the TypeScript core path by default.

## Authorable ABG MVP

The Authorable ABG MVP validates JSON graph files, runs deterministic mock node implementations, projects graph/node/model events into the existing Event Log, and exposes graph snapshots and timelines from emitted events. The bounded runtime also covers strict structured blackboard output, `fanOutKey` fan-out, static parallel waves, process-local Race winner and drain handling, and all-approve verdict aggregation; the full production ABG engine remains deferred.

Run the included research graph as JSON Lines:

```bash
pnpm dev:cli -- --json --graph examples/abg/research-answer.graph.json
pnpm dev:cli -- --json --graph examples/abg/research-answer.graph.json --model local/local-echo
```

Authorable graph files live in `examples/abg`:

- `research-answer.graph.json`: LLM node followed by an action node through a declarative success rule.
- `policy-block.graph.json`: tool node blocked by a deny policy.
- `coding-agent-denied.graph.json`: coding-agent graph whose write node is blocked by a deny policy after approval.
- `parallel-race.graph.json`: parallel, race, and join nodes using deterministic mock child nodes.
- `malformed-edge.graph.json`: intentionally invalid edge target fixture for CLI and schema tests.

The JSON shape is `id`, `entryNodeId`, `nodes`, `edges`, `rules`, and `policies`. Nodes can specify `kind`, `children`, `capabilities`, `config`, and optional model metadata with `providerID`, `modelID`, `variantID`, and fallback model options. Rules use declarative predicates only; arbitrary JavaScript expressions are rejected.

The full production ABG engine remains TODO. Provider adapter calls, durable SQLite/libSQL replay, safe tools, and approval gates are implemented for the coding-agent MVP. The visual graph editor remains out of scope for this MVP.

## Distribution

npm publication is deferred while the CLI and its workspace runtime packages remain private. Supported CLI distribution uses staged tarballs attached to GitHub Releases.

curl install from the latest GitHub Release:

```bash
curl -fsSL https://raw.githubusercontent.com/noizbuster/mission-control/main/scripts/install.sh | sh
mc
```

For forks or pre-release repositories, pass `MISSION_CONTROL_REPO=owner/repo` to the `sh` process that runs `scripts/install.sh`.

GitHub Releases use these artifact names:

- `mctrl-linux-x64.tar.gz`
- `mctrl-linux-arm64.tar.gz`
- `mctrl-darwin-x64.tar.gz`
- `mctrl-darwin-arm64.tar.gz`

The package helper creates the current-platform CLI artifact in `dist/release`. Each archive contains `mc`, the `mctrl` alias, and `mission-control-sidecar`.
It also writes a sibling `.sha256` file for GitHub Release uploads.

Desktop release:

- The release target is the `mission-control desktop app`.
- The `mission-control` desktop app is built from `apps/desktop`.
- `.github/workflows/release-desktop.yml` defines the Tauri desktop release matrix.
- Signing and notarization are release TODO items until platform credentials exist.

CI/CD with GitHub Actions:

- `.github/workflows/ci.yml` runs install, `pnpm test`, typecheck, build, lint, native sidecar tests, Tauri Rust tests, and sidecar build without live provider credentials.
- `.github/workflows/release-cli.yml` packages CLI tarballs, writes checksums, and uploads both to GitHub Releases without npm or registry credentials.
- `.github/workflows/release-desktop.yml` runs Tauri release builds and uploads desktop artifacts.

release TODO:

- Add release provenance before public release.
- Add cross-compile coverage for every artifact name.
- Add signing and notarization.

### Paired Session-Stop Release Gate

Mission Control session stop and Ground Control's Mission Control `K` flow ship as one synchronized pair. Ground Control invokes `mc` first and uses `mctrl` only when `mc` is unavailable. The pair does not inspect version, help text, or installed capabilities to select a behavior.

Local Linux verification is complete: the isolated cross-repository runner passed all five current scenarios, including child-only stop, a partial timeout, stale-settlement fencing, and guarded owner-death cleanup. That is local implementation evidence, not a hosted release result. The post-authorization release gate remains pending: it requires immutable 40-hex Mission Control and Ground Control revisions, separate checkouts, and the same runner on Linux, macOS, and Windows. No hosted execution is claimed until those jobs have receipts.

## Native Fallback

`--native` configures the sidecar client used by the legacy `runDemoTask()` path. If the sidecar cannot be found or started on that path, the runtime emits `native.warning` and completes the demo with the mock sidecar. Coding-agent provider, graph, file, and command execution remain on their TypeScript/provider paths.

Native sidecar calls use a 5000ms timeout. On timeout, the runtime emits `native.warning`, stops the sidecar process group when possible, and falls back to the mock sidecar result.

The native sidecar speaks JSON Lines protocol v1 by default. Core sends a `handshake` command before task work, and the sidecar responds with `handshake_completed`, protocol version, and capabilities. The default sidecar capability list is `task.run`; protocol v2 is opt-in and limited to `task.cancel`, `task_failed`, and `task_cancelled` wire compatibility. It is not the default executor for `file.patch` or `command.run`.

## Runtime Extension

CLI renderers implement `AgentUIRenderer` in `apps/cli/src/ui/renderers.ts`.

Renderer contract:

- `start(runtime)`: attach to the current `AgentRuntime`.
- `render(event)`: receive each append-only `AgentEvent`.
- `stop()`: release renderer resources.
- `getOutput()`: return the buffered output for CLI mode tests and process output.

The built-in renderers are `TuiRenderer`, `PlainRenderer`, and `JsonRenderer`. To add a renderer, implement `AgentUIRenderer`, render from protocol events instead of runtime internals, and add the renderer selection in `apps/cli/src/commands/run-agent.ts`.

The interactive chat surface is driven by the OpenTUI mount/handle seam: `apps/tui/src/create-chat-tui.tsx` builds the `ChatStore`, mounts a Solid component tree under `@opentui/solid` (over a node:ffi-loaded native core on Node 26.3+), and returns the `ChatTuiHandle` consumed by the imperative chat loop. Interactive layout reads live terminal size via OpenTUI `useTerminalDimensions()` (OpenCode pattern: `dimensions().width` / `dimensions().height` in JSX). A hand-rolled terminal input system remains as the non-TTY fallback path.

TUI provider architecture: `apps/tui/src/create-chat-tui.tsx` dynamically imports `@mission-control/tui/providers` and wraps `App` in `MissionControlTuiProviders`. The package exposes that provider composition root through the dedicated `./providers` subpath and matching Vite library entry; the main `@mission-control/tui` barrel remains pure terminal-text/chat/markdown/state exports so non-TUI CLI paths can import it without loading provider/OpenTUI modules. Provider composition owns runtime metadata, paths/config, runtime-event projection, project/session replay, route/dialog/theme, local preferences, prompt history, prompt services, clipboard/toast, keymap chrome, and plugin runtime hooks.

The provider persistence ownership boundary is explicit: TUI prompt history, prompt stash, frecency, local preferences, theme preference, and plugin manifest/KV data are persisted through `packages/core/src/tui-stores/` stores selected by the TUI paths provider. Components consume provider hooks and injected structural callback interfaces; they do not create `AgentRuntime`, provider adapters, tool registries, or CLI command classes.

The plugin trust contract is descriptor-first. Trusted plugin manifests can register only declared and allowlisted slot, route, command, KV, dialog, and theme capabilities through the core `TuiPluginHostRegistry`; project-local plugin descriptors stay inert until workspace trust is granted, denied capabilities emit redacted diagnostics, failed callbacks are removed with a toast, and provider cleanup disposes all registrations.

OpenCode references map to Mission Control as implementation references only. Selected ideas are ported into Mission Control boundaries: OSC52 selection copy instead of shell clipboard binaries, prompt stash/frecency stores instead of component-local state, structural focused-editor access for kill-ring behavior, and descriptor-gated plugin registrations instead of arbitrary project plugin execution. No `@opencode-ai/*` package is imported by product source.

Epilogue-style context surfaces are deferred; current TUI context display is the ABG/session replay projection provider surface. Editor parity is intentionally minimal: `Ctrl+E` opens `$VISUAL`/`$EDITOR`, and keymap layers operate on the focused OpenTUI textarea; Mission Control does not embed a full OpenCode editor subsystem.

Permission flow is implemented for the coding-agent tool path. The runtime emits permission and approval lifecycle events, default policy remains conservative, CLI can prompt synchronously, and the core desktop command service can append approval decisions over the same event stream.

## ABG-based extension points

These extension points include the bounded Authorable ABG MVP, the coding-agent provider/tool/session path, and placeholder only surfaces for future databases, vector stores, visual graph editing, and advanced schedulers.

Sub-agent model:

- `SubAgent` and `SubAgentRegistry` live in `packages/core/src/agents`.
- The registry can register and resolve mock sub-agents by id.
- Real multi-agent supervision is not implemented.

Behavior/action graph plan:

- `BehaviorNode`, `ActionGraphNode`, `ActionGraphEdge`, and `createActionGraph` live in `packages/core/src/behavior`.
- `createAuthorableAbgGraph`, `runAbgGraph`, and `AgentRuntime.runGraph` validate and run authorable graphs with bounded retries, loops, approval gates, and graph snapshots.
- The full production behavior/action graph engine is not implemented.
- Production compensation policies and visual graph editing remain out of scope.

Scheduler/executor split:

- `AgentScheduler`, `MockAgentScheduler`, and `AgentExecutor` live in `packages/core/src/runtime`.
- `MockAgentScheduler` returns a `TaskHandle` and supports a cancel placeholder.
- Real scheduling, retries, compensation, and executor orchestration are not implemented.

Memory/event model:

- `MemoryStore` and `InMemoryEventStore` live in `packages/core/src/memory`.
- SQLite/libSQL session storage appends durable protocol events and derives replay projections, graph snapshots, approval state, branch summaries, and ABG timelines. JSONL remains a replay/import/export compatibility format and is not deleted during import.
- Persistent memory snapshot compaction and the persistent memory store are implemented; vector index storage is not implemented.

Native sidecar future role:

- The Rust sidecar remains a JSON Lines execution boundary.
- Protocol v1 negotiates the `task.run` capability by default.
- Protocol v2 is feature-flagged and currently limited to `task.cancel`, `task_failed`, and `task_cancelled` compatibility.
- Future scheduler, executor, memory, and tool-running work can attach behind that boundary after feature flags and tests.
- Default `file.patch` and `command.run` execution is intentionally not routed through the sidecar.

Renderer future role:

- CLI renderers already consume protocol events.
- Future OpenTUI, ratatui-ts, or Rust Ratatui renderer work should implement the same event-rendering boundary.
- Those renderers are not implemented.

## ABG Alignment

ABG.md is the root design reference for this scaffold.

ABG concepts used in this scaffold:

- Event-oriented runtime state: sessions and task events are modeled as shared protocol objects.
- Observable control surface: CLI JSON Lines, plain output, and desktop event log all expose the same event flow.
- Snapshot projections are derived from durable events for graph, approval, branch, and session views.
- Runtime boundary separation: UI packages talk through core/protocol boundaries instead of directly owning native process behavior.
- Native execution slot: the Rust sidecar establishes a future place for scheduler and execution work without implementing the full engine.
- Durable replay: the local SQLite/libSQL `session_events` ledger reconstructs chat, approval, graph, diff, and command output state after restart; JSONL remains an import/export compatibility format. Blocking input and foreground subagent waits are mirrored into the public data-dir session DB.
- Approval-gated tools: core enforces permission decisions before file or command effects.

Boundary alignment:

- Runtime boundary: `packages/core` owns `AgentRuntime`, durable session services, replay projections, provider turns, approval enforcement, safe tools, graph coordination, timeout fallback, and cancellation interfaces.
- Protocol boundary: `packages/protocol` owns shared Zod schemas and TypeScript types for events, sessions, permissions, approvals, messages, provider streams, diffs, commands, and sidecar tasks.
- Sidecar boundary: `native/sidecar` communicates through JSON Lines and does not import TypeScript runtime internals.
- UI/runtime separation: CLI renderers and the desktop event log consume protocol events instead of owning runtime execution.

ABG reflection in this boilerplate is intentionally bounded: names, package boundaries, event schemas, fallback behavior, extension points, durable sessions, provider turns, approval-gated tools, graph snapshots, desktop inspection, persistent memory store, and core desktop approval services are present; the full production ABG engine is not.

ABG runtime TODOs:

- Additional cancellation surfaces outside the documented session-stop contract.
- Compensation policy.
- Scheduler/executor separation beyond the current bounded coordinator.
- Context packing and memory injection.

## Not Implemented Yet

- TODO: ABG full engine is not implemented.
- TODO: full production ABG engine is not implemented.
- TODO: additional provider adapters beyond local, OpenAI Responses, Anthropic Messages, Google Gemini, and the OpenAI-compatible family are not implemented.
- TODO: unrestricted file-editing tools are not implemented. `file.edit`, `file.write`, and `bash.run` are approval-gated and workspace-contained only.
- TODO: MCP tools, web tools (glob, todowrite, webfetch), subagent orchestration via the `task` tool, and skills are implemented; ACP protocol and a real LSP stdio transport are not implemented (the `lsp` tool seam exists but a JSON-RPC language-server client is deferred).
- TODO: visual graph editor remains out of scope.
- TODO: vector index storage is not implemented.
- TODO: advanced scheduler, executor, cancellation propagation, and behavior/action graph engine are not implemented.
- TODO: full desktop terminal parity is not implemented; the desktop shell never mutates files directly.

## Next Stage TODO

- Extend stop and resume behavior only with a new tested contract.
- Expand feature-flagged sidecar v2 beyond task status/failure/cancellation only after command/file parity tests.
- Add release provenance, cross-compile coverage, and signing/notarization for GitHub Releases and Tauri artifacts.
- Keep CI free of live provider credentials; live provider smoke tests stay opt-in.
