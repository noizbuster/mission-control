# mission-control

`mission-control` is a boilerplate control surface for operating observable LLM-agent workflows. The command-line entrypoint is `mctrl`, the desktop app is `mission-control`, and the native helper binary is `mission-control-sidecar`.

## Architecture

`ABG.md` is the root design reference. This scaffold reflects ABG concepts in package naming, event-oriented boundaries, UI/runtime separation, protocol boundaries, and sidecar naming only.

Directory structure:

- `apps/cli`: `mctrl` command-line app.
- `apps/desktop`: Tauri + React desktop app.
- `packages/protocol`: shared event/session/sidecar schemas.
- `packages/core`: runtime skeleton and sidecar client boundary.
- `packages/config`: shared constants.
- `native/sidecar`: Rust JSON Lines sidecar binary.
- `tests`: root workspace and integration contract tests.

Package responsibilities:

- `@mission-control/protocol`: shared schemas and types for CLI, desktop, core runtime, and Rust sidecar boundaries.
- `@mission-control/core`: runtime skeleton, event stream concepts, session snapshots, permissions, and native sidecar client boundaries.
- `@mission-control/config`: shared configuration constants.
- `@mission-control/cli`: Ink/plain/JSON command-line surface for `mctrl`.
- `@mission-control/desktop`: Tauri + React desktop surface for `mission-control`.
- `native/sidecar`: Rust JSON Lines sidecar, prepared for future scheduler and memory roles.

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
node apps/cli/dist/index.js --no-tui
```

## Interactive chat commands

`mctrl` opens a chat prompt by default. `/model opens a searchable model picker`, and `/model provider/model selects the model for the current chat only`. The selection updates scaffold metadata for subsequent prompt events and does not persist credentials or auth defaults.

`$skill args records a scaffold agent skill invocation` inside Mission Control. It does not run actual Codex host skills, spawn agents, or make provider calls. Normal prompt text still sends a prompt, and Ctrl+C twice exits.

The chat command surface is still scaffolded: model/provider selection remains metadata, skill calls are recorded as Mission Control events, and real LLM calls are not implemented.

## Model Provider Selection

The CLI accepts provider/model metadata for demo runs. The catalog combines the scaffold `local` provider with the OpenCode/Models.dev provider credential catalog, so credentials can be configured for every vendored OpenCode provider while runtime execution remains scaffolded.

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

The vendored Models.dev snapshot is generated from `https://models.dev/api.json` and is stored under `packages/config/src/generated/`. Refresh it with `node --experimental-strip-types scripts/sync-models-dev-catalog.ts`. Normal CLI commands use the vendored file only; there is no runtime fetch to Models.dev.

`mctrl auth login` supports credential setup for every vendored OpenCode provider. Single-secret providers can use `--api-key <key>` as an alias for their primary secret. Multi-field providers use repeatable `--credential FIELD=VALUE` flags. OAuth-capable providers expose OpenCode-style `--method` choices: OpenAI supports browser and headless ChatGPT OAuth plus API key login, and GitHub Copilot supports OAuth device login plus API key login. Missing credential fields are resolved from explicit CLI values, matching environment variables, existing stored values, and interactive prompts, in that order.

`mctrl auth login` can prompt interactively for provider, auth method, and credential fields when flags are omitted. Stored credentials configure the default provider/model for later demo runs, so a later `mctrl --no-tui` can use the saved default when no `--provider` or `--model` flag is passed.

Credential storage defaults to `$XDG_DATA_HOME/mission-control/auth.json` or `~/.local/share/mission-control/auth.json`. Set `MISSION_CONTROL_AUTH_FILE=/tmp/mctrl-auth.json` to use a specific auth file for tests, demos, or isolated workspaces.

API keys, OAuth tokens, and multi-field provider credentials are stored as plaintext JSON in that auth file. This scaffold does not use encrypted OS keychain storage yet; this is not encrypted keychain storage.

`mctrl models [provider]` lists scaffold and vendored provider models and shows whether each provider has a configured credential. Command output masks credentials and does not print raw API keys or raw multi-field secret values.

Interactive `/model` choices are narrower than `mctrl models`: they first require a logged-in provider, and API-key credentials for supported providers can call the provider's model-list API at chat startup. When discovery succeeds, `/model` intersects the live provider model IDs with the vendored catalog before showing, searching, or accepting a model selection. OAuth credentials, unsupported providers, failed requests, and malformed responses fall back to the vendored models for that logged-in provider.

The desktop demo control surface exposes provider/model controls, an API key credential field, credential configured/missing state, and the active selection in the status area and event log.

provider/model selection is scaffold metadata for observable control surfaces only. It does not call real LLM providers yet.

credentials are used for scaffold configuration only. They do not enable real LLM calls until a provider execution adapter is added. Mission Control does not implement real LLM provider execution in this scaffold.

The catalog also exposes the local provider/model variant `local/local-echo/default`. These variants are metadata for graph and event observability only.

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
- `parallel-race.graph.json`: parallel, race, and join nodes using deterministic mock child nodes.
- `malformed-edge.graph.json`: intentionally invalid edge target fixture for CLI and schema tests.

The JSON shape is `id`, `entryNodeId`, `nodes`, `edges`, `rules`, and `policies`. Nodes can specify `kind`, `children`, `capabilities`, `config`, and optional model metadata with `providerID`, `modelID`, `variantID`, and fallback model options. Rules use declarative predicates only; arbitrary JavaScript expressions are rejected.

The full production ABG engine remains TODO. Real providers, real tools, durable persistence, and visual graph editor remain out of scope for this MVP.

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
curl -fsSL https://raw.githubusercontent.com/<OWNER>/mission-control/main/scripts/install.sh | sh
mctrl
```

GitHub Release artifact naming:

- `mctrl-linux-x64.tar.gz`
- `mctrl-linux-arm64.tar.gz`
- `mctrl-darwin-x64.tar.gz`
- `mctrl-darwin-arm64.tar.gz`

The package helper creates the current-platform CLI artifact in `dist/release`. Each archive contains `mctrl` and `mission-control-sidecar`.

Desktop release:

- The release target is the `mission-control desktop app`.
- The `mission-control` desktop app is built from `apps/desktop`.
- `.github/workflows/release-desktop.yml` defines the Tauri desktop release matrix.
- Signing and notarization are release TODO items until platform credentials exist.

CI/CD with GitHub Actions:

- `.github/workflows/ci.yml` runs install, typecheck, build, and sidecar build.
- `.github/workflows/release-cli.yml` packages CLI artifacts and publishes npm only when `NPM_TOKEN` is present.
- `.github/workflows/release-desktop.yml` runs Tauri release builds and uploads desktop artifacts.

release TODO:

- Add real repository owner in install examples before public release.
- Add cross-compile coverage for every artifact name.
- Add signing, notarization, checksums, and provenance.

## Native Fallback

The CLI should try the configured native sidecar when `--native` is used. If the sidecar cannot be found or started, the runtime must emit `native.warning` and complete the demo with the mock sidecar.

Native sidecar calls use a 5000ms timeout. On timeout, the runtime emits `native.warning`, stops the sidecar process group when possible, and falls back to the mock sidecar result.

## Runtime Extension

CLI renderers implement `AgentUIRenderer` in `apps/cli/src/ui/renderers.ts`.

Renderer contract:

- `start(runtime)`: attach to the current `AgentRuntime`.
- `render(event)`: receive each append-only `AgentEvent`.
- `stop()`: release renderer resources.
- `getOutput()`: return the buffered output for CLI mode tests and process output.

The built-in renderers are `InkRenderer`, `PlainRenderer`, and `JsonRenderer`. To add a renderer, implement `AgentUIRenderer`, render from protocol events instead of runtime internals, and add the renderer selection in `apps/cli/src/commands/run-agent.ts`.

Permission flow is present as a skeleton. The runtime emits `permission.requested` with a `PermissionRequest` and a default `PermissionDecision`. The default decision is `deny`; no real permission UI input is implemented yet.

## ABG-based extension points

These extension points include the bounded mock Authorable ABG MVP plus placeholder only surfaces for future production providers, tools, databases, vector stores, and schedulers.

Sub-agent model:

- `SubAgent` and `SubAgentRegistry` live in `packages/core/src/agents`.
- The registry can register and resolve mock sub-agents by id.
- Real multi-agent supervision is not implemented.

Behavior/action graph plan:

- `BehaviorNode`, `ActionGraphNode`, `ActionGraphEdge`, and `createActionGraph` live in `packages/core/src/behavior`.
- `createAuthorableAbgGraph`, `runAbgGraph`, and `AgentRuntime.runGraph` validate and run authorable mock graphs.
- The full production behavior/action graph engine is not implemented.
- Production behavior/action graph execution with retries, compensation, and real tool effects remains out of scope.

Scheduler/executor split:

- `AgentScheduler`, `MockAgentScheduler`, and `AgentExecutor` live in `packages/core/src/runtime`.
- `MockAgentScheduler` returns a `TaskHandle` and supports a cancel placeholder.
- Real scheduling, retries, compensation, and executor orchestration are not implemented.

Memory/event model:

- `MemoryStore` and `InMemoryEventStore` live in `packages/core/src/memory`.
- The in-memory store appends protocol events and derives task snapshots, graph snapshots, and ABG timelines through the same Event Log path.
- Persistent event log storage, memory snapshot compaction, persistent memory store, and vector index are not implemented.

Native sidecar future role:

- The Rust sidecar remains a JSON Lines execution boundary.
- Future scheduler, executor, memory, and tool-running work can attach behind that boundary.
- Real tool execution is not implemented.

Renderer future role:

- CLI renderers already consume protocol events.
- Future OpenTUI, ratatui-ts, or Rust Ratatui renderer work should implement the same event-rendering boundary.
- Those renderers are not implemented.

## ABG Alignment

ABG.md is the root design reference for this scaffold.

ABG concepts used in this scaffold:

- Event-oriented runtime state: sessions and task events are modeled as shared protocol objects.
- Observable control surface: CLI JSON Lines, plain output, and desktop event log all expose the same event flow.
- Runtime boundary separation: UI packages talk through core/protocol boundaries instead of directly owning native process behavior.
- Native execution slot: the Rust sidecar establishes a future place for scheduler and execution work without implementing the full engine.

Boundary alignment:

- Runtime boundary: `packages/core` owns `AgentRuntime`, append-only Event Log, Snapshot derivation, permissions, timeout fallback, and cancellation interfaces.
- Protocol boundary: `packages/protocol` owns shared Zod schemas and TypeScript types for events, sessions, permissions, messages, and sidecar tasks.
- Sidecar boundary: `native/sidecar` communicates through JSON Lines and does not import TypeScript runtime internals.
- UI/runtime separation: CLI renderers and the desktop event log consume protocol events instead of owning runtime execution.

ABG reflection in this boilerplate is intentionally bounded: names, package boundaries, event schemas, fallback behavior, extension points, and a mock authorable graph runtime are present; the full production ABG engine is not.

ABG runtime TODOs:

- Event replay from persisted logs.
- Full cancellation propagation through task handles.
- Retry and compensation policy.
- Scheduler/executor separation beyond the demo task.
- Real permission UI and policy decisions.
- Context packing and memory injection.

## Not Implemented Yet

- TODO: ABG full engine is not implemented.
- TODO: full production ABG engine is not implemented.
- TODO: real LLM provider is not implemented.
- TODO: real file-editing tools are not implemented.
- TODO: real providers, real tools, durable persistence, and visual graph editor remain out of scope.
- TODO: persistent memory store, vector index, and database storage are not implemented.
- TODO: advanced scheduler, executor, cancellation propagation, and behavior/action graph engine are not implemented.

## Next Stage TODO

- Add cancellation propagation and resume semantics to the runtime.
- Replace mock permission/session flows with typed command APIs.
- Wire desktop to Tauri commands through `agent-client.ts`.
- Add distribution packaging for npm, GitHub Releases, and Tauri artifacts.
- Add CI once Stage 02 runtime behavior is stable.
