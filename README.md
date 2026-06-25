# mission-control

`mission-control` is a staged control surface for operating observable LLM-agent workflows. The command-line entrypoint is `mctrl`, the desktop app is `mission-control`, and the native helper binary is `mission-control-sidecar`.

## Architecture

`ABG.md` is the root design reference. The current runtime implements a bounded coding-agent MVP over the original scaffold: provider turns, durable JSONL sessions, approval-gated tools, replay projections, graph coordination, behavior/action graph execution for authorable graphs, CLI chat, desktop inspection, core desktop command services, and a versioned sidecar handshake.

Directory structure:

- `apps/cli`: `mctrl` command-line app.
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
- `@mission-control/cli`: opentui/plain/JSON command-line surface for `mctrl`.
- `@mission-control/desktop`: Tauri + React desktop surface for `mission-control`.
- `native/sidecar`: Rust JSON Lines sidecar with protocol v1 `task.run` negotiation and opt-in protocol v2 compatibility tests.

Confirmed names:

- `apps/cli/package.json` maps the `mctrl` bin to `./dist/index.js`.
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

## Interactive chat commands

`mctrl` opens a chat prompt by default. `/model opens a searchable model picker`, and `/model provider/model selects the model for the current chat only`. The selection updates the active chat model and does not persist credentials or auth defaults.

Session navigation stays on the durable JSONL session surface: `/new [session-id]` starts a new durable session, `/session <session-id>` switches to an existing durable session, `/sessions` lists durable sessions, `/tree` shows the durable session tree and active leaf, `/branch <entry-id>` selects an existing branch leaf, `/branch <message-id> <prompt>` continues from a parent message in a new branch, `/fork <entry-id> [session-id]` forks from a tree entry into a new durable session, and `/clone [session-id]` clones the current durable session into a fresh one. `/compact` summarizes older session history into a durable compaction boundary event, keeping the session durable while reducing replay context. `/resume` resumes a blocked run that is waiting on an approval decision, re-entering the approval-blocked lifecycle.

Workspace trust is controlled interactively with `/trust` (trust the current workspace for project-local resources), `/trust status` (show the current trust decision), `/trust deny` (deny project-local resources for the workspace), and `/trust reset` (clear the trust decision). Trust decisions persist in the project trust store under the Mission Control data directory. `bash.run`, `file.edit`, and `file.write` are only available when the workspace is trusted; read-only tools work regardless of trust but still enforce workspace path guards.

`$skill <name> [args]` loads the named skill's `SKILL.md` body and submits it as the user message (real skill loading, replacing the old scaffold recorder). `/<skill-name>` is the slash-command equivalent and reserved commands take precedence over skill names. Skill bodies are inert text only; it does not run actual Codex host skills, spawn agents, or make provider calls on its own. Normal prompt text still sends a prompt, and Ctrl+C twice exits.

`#<workflow-name> {prompt}` invokes a named workflow with the given prompt. Workflows are discovered from `.mctrl/workflows/`, `.agents/workflows/`, and the config workflows directory. A prompt without a `#` prefix runs the `default` workflow fallback. Four built-in workflows ship with the runtime: `default` (no-`#` fallback), `planner` (read-only planning), `runner` (plan execution), and `autopilot` (a mode overlay applied to any workflow). See Built-in Workflows below.

`/agents` inspects and manages discovered agents. `/agents` with no argument lists every discovered agent with its source, model, and tier. `/agents <name>` shows full details for one agent (description, tools, spawns, thinking level, max turns, recursion, file path, disabled status). `/agents reload` re-runs discovery without restarting the chat. `/agents disable <name>` disables a single agent so it cannot be spawned via `task()`. The reserved subcommands `reload` and `disable` take precedence over any agent literally named `reload` or `disable`. See Agent System below.

The chat command surface is mixed: normal prompts can run through the deterministic local provider, OpenAI Responses, Anthropic Messages, Google Gemini, or the OpenAI-compatible adapter family for OpenRouter, Groq, DeepSeek, and Mistral when credentials are configured. Skill loading is real — the `SKILL.md` body becomes the next user prompt — but the default `local/local-echo` provider does not call tools, so a real tool-calling provider is required for loaded skills to drive agentic behavior.

## Keyboard Shortcuts

Interactive chat chords are defined in the keybind registry (`apps/cli/src/platform/keymap/keybind.ts`) and rebindable via a `keybinds.json` config file. `/hotkeys` lists every binding grouped by namespace and auto-reflects any rebind. A few chords are resolved against the textarea's native editing defaults so both the app action and the editing behavior survive:

- `Ctrl+E` opens the external editor (input line-end is `Ctrl+Shift+E`).
- `Ctrl+Z` suspends the terminal (undo/redo are `Ctrl+-` / `Ctrl+.`).
- `Home` / `End` scroll the transcript (buffer-home/end are `Ctrl+Shift+Home` / `Ctrl+Shift+End`).
- `Ctrl+P` cycles the model (the command palette is `Alt+X`).
- `Ctrl+G` toggles the ABG monitoring overlay.
- `Ctrl+C` (twice) interrupts or exits; it is hardcoded and routes through the global keyboard sink, not the keybind registry.

## Built-in Workflows

Four built-in workflows ship with the workflow runtime. The first three are graph files discovered from `examples/abg/`; autopilot is a mode overlay, not a standalone graph.

- **`default`**: the no-`#` fallback. An intent gate classifies a prompt as trivial (direct respond), explicit (memory recall, todo planning, delegate wave via `task()` fan-out, verify wave with a critic, supervisor retry loop), or ambiguous (clarify loop). Running `mctrl` with a plain prompt (no `#` prefix) invokes this workflow.
- **`planner`**: read-only planning. An ambiguity gate routes clear requests through codebase exploration and plan drafting, unclear requests through best-practice research and default adoption, and on-the-fence requests through a single clarifying question. The planner writes plan artifacts to `.omo/plans/` and spec artifacts to `.omo/specs/` only; all other writes are denied by the `planner-readonly` mode. Invoke with `#planner {your planning request}`.
- **`runner`**: plan execution. Parses a plan checklist from `.omo/plans/`, delegates waves of tasks via `task()` fan-out with per-task critic verification, updates checkboxes, loops until all tasks are done, then runs a final four-critic verification wave (goal, constraints, tests, code quality). Routes to a completion report or a fix-loop that reopens tasks. Invoke with `#runner {execute plan <slug>}`.
- **`autopilot`**: a mode overlay, not a standalone graph. Prepends six operating directives (certainty before action, scenario before edit, test-driven discipline, QA verification, reviewer separation, completion discipline) to every LLM node and adds a hard policy-gate rule requiring approval before any edit. Applied to any workflow via `modeDeclarations` in the workflow spec.

Non-interactive equivalent: `mctrl run --workflow <name> "<prompt>"` (mutually exclusive with `--graph`). The model can also self-invoke a workflow through the `workflow(name, prompt)` tool, which resolves the name via the workflow registry and returns a `started` or `not_found` status.

Discovered workflows are listed to the model in an `<available_workflows>` system-prompt block. Custom workflows follow the same `*.workflow.json` or `*.workflow.jsonc` format and the same three-scope first-wins discovery as skills (global config dir, `.mctrl/workflows/`, `.agents/workflows/`).

## Agent System

The agent system discovers, validates, and resolves deployable subagents that the `task()` tool spawns as child coding agents. Agents are markdown files with YAML frontmatter, discovered across four builtin scopes plus nine cross-harness importers, first-wins by name. Discovery, parsing, the by-name registry, recursion bounds, and approval tiers are implemented and test-covered. The default spawn function still throws `not_yet_implemented`, so live child-agent execution through `task()` requires the CLI graph-runner connection before it runs end to end.

Agent discovery scopes (first-wins by name):

- Project: `<workspace>/.mctrl/agents/`.
- User: `<config-dir>/agents/`.
- Plugin: configured `additionalDirs`.
- Bundled: runtime agents shipped with `@mission-control/core` (`deep`, `quick`, `ultrabrain`, `visual-engineering`, `explore`, `oracle`, `librarian`, `metis`, `momus`).

Cross-harness importers (priority 50, lower than the builtin 100) scan each harness's own agent directories and import what they find: Claude Code, Cursor, Codex, Gemini, Cline, Windsurf, VS Code, GitHub Copilot, and OpenCode. A mission-control agent always wins a name conflict over an imported one. Discovery is discovery-safe: symbolic links are skipped, paths on the shared read-tool denylist are pruned, files above the 64KB size bound are skipped, the agent count is capped at 256, and discovery never throws. Broken files emit diagnostics and are skipped rather than failing the run.

Agent definition format:

- Required frontmatter: `name`, `description`.
- Required body: a non-empty markdown body, parsed into the agent's `systemPrompt`.
- Optional frontmatter: `tools` (CSV string, array, or object map of enabled tools), `spawns` (array or `'*'`), `model` (string or `{providerID, modelID}`), `thinkingLevel` (`low`/`medium`/`high`/`xhigh`), `tier` (`read`/`write`/`exec`), `maxTurns`, `recursion` (`-1` for unlimited), `role`, `pathPolicies`, `autoloadSkills`, `blocking`.
- The schema is strict; unknown frontmatter keys are rejected.

Managing agents in interactive chat:

- `/agents` lists every discovered agent with its source, model, and tier.
- `/agents <name>` shows full details for one agent.
- `/agents reload` re-runs discovery without restarting the chat.
- `/agents disable <name>` disables a single agent so it cannot be spawned via `task()`.

Spawning child agents:

- `task()` delegates a bounded sub-task to a child coding agent. The single form takes `{ agent: '<name>', assignment: '<prompt>' }`; the batch form takes `{ tasks: [{ agent, assignment, role? }, ...] }` and runs the wave concurrently.
- The child tool surface is recursively restricted: the child loses the `task` tool (registry-layer recursion guard), gains a `yield` tool for result submission, and drops tools whose capability classes are denied by the derived path policies.
- Recursion is bounded. `DEFAULT_MAX_RECURSION_DEPTH=2` means a root agent (depth 0) may spawn a child (depth 1), and that child may spawn one grandchild (depth 2 is the blocked boundary). `HARD_RECURSION_CAP=10` bounds even `recursion: -1` unlimited configurations.
- Approval tiers rank tools `read` (0), `write` (1), `exec` (2). The active `ApprovalMode` (`always-ask`, `write`, `yolo`) controls how many tiers auto-approve. Per-tool user policies (`prompt`/`deny`/`allow`) override the mode. Child `task()` sessions are forced to `yolo` mode, so the parent's `task()` approval is the authorization boundary for the whole child run.

Adopted child agents run under an idle-to-parked-to-revived lifecycle (default 7 minute idle TTL) and a concurrency-bounded async job manager. Both are in-memory only; persistence is deferred.

## Model Provider Selection

The CLI accepts provider/model selection for demo and coding-agent runs. The catalog combines the scaffold `local` provider with the OpenCode/Models.dev provider credential catalog. Runtime execution is implemented for the deterministic local provider, OpenAI Responses, Anthropic Messages, Google Gemini, and the OpenAI-compatible adapter family for OpenRouter, Groq, DeepSeek, and Mistral. Other vendored providers can be configured for credentials and catalog selection but do not have execution adapters yet.

```bash
pnpm dev:cli -- --no-tui --provider local --model local-echo
pnpm dev:cli -- --json --model local/local-echo
mctrl auth login --provider local --api-key <key>
mctrl auth login --provider anthropic --api-key <key>
mctrl auth login --provider openai --method oauth-headless
mctrl auth login --provider github-copilot --method oauth
mctrl auth login --provider cloudflare-ai-gateway --credential apiToken=<token> --credential accountId=<account> --credential gatewayId=<gateway>
mctrl auth login --provider amazon-bedrock --credential region=<region> --credential accessKeyId=<key-id> --credential secretAccessKey=<secret>
mctrl auth login
mctrl auth list
mctrl auth logout --provider local
mctrl models local
```

Installed `mctrl` provider-backed examples should use isolated data and auth paths for repeatable local tests:

```bash
MCTRL_DATA_DIR=/tmp/mctrl-demo-data MISSION_CONTROL_AUTH_FILE=/tmp/mctrl-demo-auth.json mctrl auth login --provider local --api-key local_test_key
MCTRL_DATA_DIR=/tmp/mctrl-demo-data MISSION_CONTROL_AUTH_FILE=/tmp/mctrl-demo-auth.json mctrl run "summarize this repository" --session session_demo --jsonl --provider local --model local-echo
MCTRL_DATA_DIR=/tmp/mctrl-demo-data MISSION_CONTROL_AUTH_FILE=/tmp/mctrl-demo-auth.json mctrl session replay session_demo --jsonl
```

The vendored Models.dev snapshot is generated from `https://models.dev/api.json` and is stored under `packages/config/src/generated/`. Refresh it with `node --experimental-strip-types scripts/sync-models-dev-catalog.ts`. Normal CLI commands use the vendored file only; there is no runtime fetch to Models.dev.

`mctrl auth login` supports credential setup for every vendored OpenCode provider. Single-secret providers can use `--api-key <key>` as an alias for their primary secret. Multi-field providers use repeatable `--credential FIELD=VALUE` flags. OAuth-capable providers expose OpenCode-style `--method` choices: OpenAI supports browser and headless ChatGPT OAuth plus API key login, and GitHub Copilot supports OAuth device login plus API key login. Missing credential fields are resolved from explicit CLI values, matching environment variables, existing stored values, and interactive prompts, in that order.

`mctrl auth login` can prompt interactively for provider, auth method, and credential fields when flags are omitted. Stored credentials configure the default provider/model for later demo runs, so a later `mctrl --no-tui` can use the saved default when no `--provider` or `--model` flag is passed.

Credential storage defaults to `$XDG_DATA_HOME/mission-control/auth.json` or `~/.local/share/mission-control/auth.json`. Set `MISSION_CONTROL_AUTH_FILE=/tmp/mctrl-auth.json` to use a specific auth file for tests, demos, or isolated workspaces.

API keys, OAuth tokens, and multi-field provider credentials are stored as plaintext JSON in that auth file. This scaffold does not use encrypted OS keychain storage yet; this is not encrypted keychain storage.

`mctrl models [provider]` lists scaffold and vendored provider models and shows whether each provider has a configured credential. Command output masks credentials and does not print raw API keys or raw multi-field secret values.

Interactive `/model` choices are narrower than `mctrl models`: they first require a logged-in provider, and API-key credentials for supported providers can call the provider's model-list API at chat startup. When discovery succeeds, `/model` intersects the live provider model IDs with the vendored catalog before showing, searching, or accepting a model selection. OAuth credentials, unsupported providers, failed requests, and malformed responses fall back to the vendored models for that logged-in provider.

The desktop demo control surface exposes provider/model controls, an API key credential field, credential configured/missing state, and the active selection in the status area and event log. The Tauri desktop client saves and lists API-key credentials through the same auth file used by the CLI, and desktop prompt/resume/approval commands route through the core provider factory.

Provider capability statuses separate executable adapters from catalog-only entries. `local`, `openai`, `anthropic`, `google`, `openrouter`, `groq`, `deepseek`, `mistral`, and `zai-coding-plan` can run coding-agent prompts through implemented adapters. Other catalog entries can be `model-discovery-only`, `auth-only`, or unsupported for prompt execution until they have adapter tests and an executable integration proof. Provider-backed coding commands require an executable adapter proof before a provider can run.

provider/model selection is scaffold metadata for observable control surfaces only in demo-only commands, and a demo command does not call real LLM providers yet.

credentials are used by implemented provider adapters only. For providers without execution adapters, credentials are used for scaffold configuration only. The OpenAI Responses adapter is implemented behind stored provider credentials, defaults requests to `store: false`, and the Anthropic, Google Gemini, and OpenAI-compatible adapters use the same provider-neutral streaming and redaction boundary. Raw secrets stay out of protocol events, JSONL logs, CLI output, desktop props/state snapshots, and error messages. Mission Control does not implement real LLM provider execution for providers without an adapter.

The catalog also exposes the local provider/model variant `local/local-echo/default`. These variants are metadata for graph and event observability only.

## Coding Agent Runtime

The coding-agent MVP now includes durable chat sessions, provider streaming, approval-gated local tools, replay projections, bounded graph orchestration, CLI chat, core desktop approval services, project workspace trust, permission profiles, an expanded coding-agent tool set, session tree navigation, manual compaction, and session export/import.

For release-adjacent local verification, `pnpm smoke:coding-agent-built-dist` runs the built-dist coding-agent smoke against a temporary trusted workspace and temporary auth/data paths, prints the captured command output plus the temp `sessions/<session-id>.jsonl` path, and fails if either the blocked replay preview or the resumed replay emits diagnostics. This is intentionally a built-dist coding-agent smoke, not a tarball artifact smoke; Todo 18 owns the tarball artifact smoke.

Session storage:

- `MCTRL_DATA_DIR` overrides the Mission Control data directory.
- Without `MCTRL_DATA_DIR`, session logs use the platform application-data directory.
- Session event logs live at `sessions/<session-id>.jsonl`.
- JSONL logs contain durable event envelopes with stable event ids, sequence numbers, causation/correlation ids, and replay cursors.
- Use --json for transient JSON Lines rendering and --jsonl for JSON Lines rendering plus replayable session persistence.

Workspace selection:

- `--workspace <path>` pins the target project directory the coding agent operates on.
- `MCTRL_WORKSPACE` env var is the equivalent for tests/scripts that want to avoid command-line flags.
- Without either, the runtime walks up from `process.cwd()` looking for `.git` or a workspace `package.json`.
- The interactive StatusBar shows the resolved workspace's basename plus the current git branch.

Provider path:

- The deterministic `local/local-echo` provider is available for offline tests and demos.
- The OpenAI Responses adapter is implemented for real provider turns when OpenAI credentials are configured.
- Anthropic Messages, Google Gemini, and OpenAI-compatible adapters are implemented for `anthropic`, `google`, `openrouter`, `groq`, `deepseek`, `mistral`, and `zai-coding-plan` when credentials are configured.
- Live provider smoke tests are opt-in only and are not required for CI.
- Unsupported providers remain catalog/auth entries until an execution adapter is added.
- Providers without execution adapters remain catalog/auth entries and must not be documented as executable.

Approval lifecycle and safe tools:

- Approval events use `approval.requested`, `approval.updated`, `approval.resumed`, and `approval.blocked`.
- Effectful tools do not execute until approval state is `approved`.
- The read-only safe tool set is `repo.read`, `repo.list`, `repo.search`, `file.patch`, and `command.run`.
- Read aliases `read`, `ls`, `grep`, and `find` mirror the read-only tools with the same workspace path guards and permission checks.
- Reference repositories under `temp/ref-repos` are planning evidence only.
- `repo.read`, `repo.list`, and `repo.search` deny `temp/ref-repos` by default, along with generated and cache directories.
- Runtime prompts and tool instructions must not load AGENTS.md or other instructions from reference repos.
- `file.patch` enforces workspace containment, symlink escape rejection, patch bounds, dirty tracked-file checks, and before/after diff events.
- `command.run` uses a fixed verification-harness allowlist, non-interactive execution, timeouts, output caps, and command lifecycle events.

Workspace trust:

- The project trust store lives at `trust/projects.json` under the Mission Control data directory.
- `/trust` marks the workspace as trusted; `/trust deny` denies project-local resources; `/trust reset` clears the decision.
- `bash.run`, `file.edit`, and `file.write` require a trusted workspace before registration.
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
- Exact replacement: `file.edit` replaces exact text in an existing file, with occurrence counting and diff events.
- Full create/replace: `file.write` creates or replaces a file with full text content, with optional parent-directory creation and binary-content refusal.
- Unified diff: `file.patch` applies unified diffs with workspace containment and dirty-file checks.
- Verification harness: `command.run` uses a fixed allowlist, non-interactive execution, timeouts, and output caps.
- Trusted bash: `bash.run` runs non-interactive bash with strict command-line parsing, an environment variable allowlist, cwd containment within the workspace, a 30-second timeout, 64KB output cap, single-invocation concurrency, and secret redaction.
- `file.edit`, `file.write`, `file.patch`, `command.run`, and `bash.run` require approval before executing.
- `bash.run` additionally requires a trusted workspace.
- File mutations serialize through a shared workspace mutation queue with pre-approval and post-approval target revalidation to prevent TOCTOU workspace escape.

Skills + MCP:

- Skills are implemented: `SKILL.md` files are discovered (global, project `.mctrl/skills`, project `.agents/skills`), listed to the model in an `<available_skills>` system-prompt block, and loaded on demand via the `skill` tool or the `/<skill-name>` and `$skill <name>` chat inputs. Skill bodies are framed as reference DATA, never as trusted policy.
- MCP tools are implemented: configured MCP servers (stdio or remote) connect eagerly at session start, surface their tools as namespaced `mcp__<server>__<tool>` merged with the built-in registry, and disconnect cleanly on stop. A crashing or hanging server is skipped at its deadline with a warning so the run continues without it. Arbitrary MCP server output is framed as untrusted DATA and capped before reaching the model; expanded env/header secret values are redacted from tool output, errors, and session logs.
- web tools (glob, todowrite, webfetch) are implemented: `glob` and `todowrite` are read-class (no approval), `webfetch` is network-class and approval-required on both flat and graph paths.
- subagent orchestration via the task tool is implemented: `task` delegates a bounded sub-task to a child coding agent whose tool surface is recursively restricted (no nested `task`, no network, no `mcp__*`).
- A real tool-calling provider is required for agentic behavior — the default `local/local-echo` provider does not call tools, so skills, MCP tools, and the coding-agent tools only take effect when a tool-calling provider is configured.
- LSP integration transport is deferred: the `lsp` tool seam exists and registers only when a real `LspClient` is injected (default runs omit it); a stdio JSON-RPC language-server transport is follow-up work.

Graph limits:

- graph node concurrency defaults to 2.
- provider parallel tool calls default to 4.
- shell/process concurrency defaults to 1.
- node retries and graph loops are bounded by explicit runtime limits.

Noninteractive JSON/JSONL run states:

- `mctrl run "<prompt>" --no-tui` and `--json`/`--jsonl` modes run a single prompt through the coding-agent path with the full tool set.
- Run receipts settle as `completed`, `failed`, `interrupted`, or `blocked_on_approval`.
- `blocked_on_approval` means the run paused for an approval decision and can be resumed with `/resume` in interactive mode or by appending an approval decision to the session log.
- `--jsonl` persists a replayable session log; `--json` emits transient JSON Lines without persistence.
- Noninteractive runs do not auto-approve effectful tools; they block and wait for external approval.

Session export, import, compaction, and stats:

- `mctrl session export <id> <path>` writes a checksummed session archive file with manifest, events, and SHA-256 checksum.
- `mctrl session import <path>` imports a session archive into a new durable session.
- `mctrl session list` lists sessions with lock status, event counts, message counts, and trust status.
- `mctrl session show <id>` shows the session snapshot, approvals, tool outcomes, coding steps, and diagnostics.
- `mctrl session replay <id> --jsonl` replays durable events and coding steps as JSON Lines.
- `/compact` in interactive chat summarizes older session history into a durable compaction boundary event, reducing replay context while preserving the session tree.

Desktop scope:

- The desktop reads durable JSONL logs, renders timeline/graph/session projections, and shows patch/test output.
- `packages/core` contains desktop command services for prompt, queue follow-up, steer, interrupt, resume, and approval decisions.
- desktop Tauri write commands call the core desktop session command service through the Rust shell bridge and return real `eventsWritten` counts.
- desktop Tauri credential commands save and list API-key credentials through the shared auth file, and restarted prompt/resume/approval commands reuse the session's persisted provider selection.
- The desktop shell never mutates files directly; permission enforcement and file/command effects stay in `packages/core`.

Sidecar status:

- Sidecar protocol v1 negotiates `task.run` by default.
- Feature-flagged sidecar protocol v2 negotiates `task.cancel` plus `task_failed` and `task_cancelled` wire responses only when core enables `enableSidecarProtocolV2` and the sidecar runs with `MCTRL_SIDECAR_V2=1`.
- The runtime emits `native.status` and `native.warning` to distinguish `unknown`, `native`, `unavailable`, and `mock` sidecar states.
- file.patch and command.run stay on the TypeScript core path by default.

## Authorable ABG MVP

The Authorable ABG MVP validates JSON graph files, runs deterministic mock node implementations, projects graph/node/model events into the existing Event Log, and exposes graph snapshots and timelines from emitted events.

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

The full production ABG engine remains TODO. Provider adapter calls, durable JSONL replay, safe tools, and approval gates are implemented for the coding-agent MVP. The visual graph editor remains out of scope for this MVP.

## Distribution

npm CLI install:

```bash
npm install -g @mission-control/cli
mctrl
```

The current scoped package name is `@mission-control/cli`. A future unscoped package can use:

```bash
npm install -g mission-control
mctrl
```

curl install:

```bash
curl -fsSL https://raw.githubusercontent.com/noizbuster/mission-control/main/scripts/install.sh | sh
mctrl
```

For forks or pre-release repositories, pass `MISSION_CONTROL_REPO=owner/repo` to the `sh` process that runs `scripts/install.sh`.

GitHub Release artifact naming:

- `mctrl-linux-x64.tar.gz`
- `mctrl-linux-arm64.tar.gz`
- `mctrl-darwin-x64.tar.gz`
- `mctrl-darwin-arm64.tar.gz`

The package helper creates the current-platform CLI artifact in `dist/release`. Each archive contains `mctrl` and `mission-control-sidecar`.
It also writes a sibling `.sha256` file for GitHub Release uploads.

Desktop release:

- The release target is the `mission-control desktop app`.
- The `mission-control` desktop app is built from `apps/desktop`.
- `.github/workflows/release-desktop.yml` defines the Tauri desktop release matrix.
- Signing and notarization are release TODO items until platform credentials exist.

CI/CD with GitHub Actions:

- `.github/workflows/ci.yml` runs install, `pnpm test`, typecheck, build, lint, native sidecar tests, Tauri Rust tests, and sidecar build without live provider credentials.
- `.github/workflows/release-cli.yml` packages CLI artifacts and publishes npm only when `NPM_TOKEN` is present.
- `.github/workflows/release-desktop.yml` runs Tauri release builds and uploads desktop artifacts.

release TODO:

- Add release provenance before public release.
- Add cross-compile coverage for every artifact name.
- Add signing and notarization.

## Native Fallback

The CLI should try the configured native sidecar when `--native` is used. If the sidecar cannot be found or started, the runtime must emit `native.warning` and complete the demo with the mock sidecar.

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

The interactive chat surface is driven by the opentui bridge: it mounts a React component tree under `@opentui/react` (over a node:ffi-loaded native core on Node 26.3+), using `useKeyboard` plus a KeyEvent adapter for keyboard handling and React components (TextInput, SlashCommandMenu, ModelSelector, MessageList, StatusBar, ApprovalPrompt) for rendering. The opentui React tree bridges to the imperative chat loop through `apps/cli/src/commands/opentui-chat-bridge.tsx`. A hand-rolled terminal input system remains as the non-TTY fallback path.

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
- JSONL session storage appends durable protocol events and derives replay projections, graph snapshots, approval state, branch summaries, and ABG timelines.
- Persistent memory snapshot compaction, persistent memory store, and vector index are not implemented.

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
- Durable replay: JSONL event logs reconstruct chat, approval, graph, diff, and command output state after restart.
- Approval-gated tools: core enforces permission decisions before file or command effects.

Boundary alignment:

- Runtime boundary: `packages/core` owns `AgentRuntime`, durable session services, replay projections, provider turns, approval enforcement, safe tools, graph coordination, timeout fallback, and cancellation interfaces.
- Protocol boundary: `packages/protocol` owns shared Zod schemas and TypeScript types for events, sessions, permissions, approvals, messages, provider streams, diffs, commands, and sidecar tasks.
- Sidecar boundary: `native/sidecar` communicates through JSON Lines and does not import TypeScript runtime internals.
- UI/runtime separation: CLI renderers and the desktop event log consume protocol events instead of owning runtime execution.

ABG reflection in this boilerplate is intentionally bounded: names, package boundaries, event schemas, fallback behavior, extension points, durable sessions, provider turns, approval-gated tools, graph snapshots, desktop inspection, and core desktop approval services are present; the full production ABG engine is not.

ABG runtime TODOs:

- SQLite indexes over persisted logs.
- Full cancellation propagation through task handles.
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
- TODO: persistent memory store, vector index, and database storage are not implemented.
- TODO: advanced scheduler, executor, cancellation propagation, and behavior/action graph engine are not implemented.
- TODO: full desktop terminal parity is not implemented; the desktop shell never mutates files directly.

## Next Stage TODO

- Add cancellation propagation and resume semantics to the runtime.
- Add SQLite indexing for JSONL session logs.
- Expand feature-flagged sidecar v2 beyond task status/failure/cancellation only after command/file parity tests.
- Add release provenance, cross-compile coverage, and signing/notarization for npm, GitHub Releases, and Tauri artifacts.
- Keep CI free of live provider credentials; live provider smoke tests stay opt-in.
