# CLI Agent Guide

## Overview

`apps/cli` owns the `mc` command-line application (`mctrl` alias retained): argument parsing, command orchestration, auth/model/session commands, terminal interaction, noninteractive renderers (plain/JSON/JSONL), and the interactive chat loop that drives the TUI surface.

The interactive chat loop (`runInteractiveChatSession` in `interactive-chat.ts`) consumes a `ChatTuiHandle` produced by `@mission-control/tui/create-chat-tui`. The TUI mount, Solid/OpenTUI components, keymap platform, markdown/diff renderers, and the `ChatStore` state cluster all live in `apps/tui` now. `apps/cli` lazy-loads them only when the TUI is active (`useTui === true`); the noninteractive path (`--no-tui`, `--json`, `--jsonl`) never touches opentui or the Solid TUI runtime.

CLI-owned runtime pieces that still live here: the imperative chat loop, the background agent-runner state machine (`chat-agent-runner.ts`), command parsing (`chat-commands.ts`), interactive chat actions (`interactive-chat-actions.ts`), approval brokering (`interactive-approval-broker.ts`), provider/model selection, auth, sessions, models, and the noninteractive renderers (`renderers.ts`). See `apps/tui/AGENTS.md` for the TUI rendering, components, platform code, and store internals.

## opentui Integration

The CLI reaches the TUI exclusively through `@mission-control/tui` lazy imports. `interactive-chat.ts` has no static import of `create-chat-tui`, components, platform, or OpenTUI. It uses `import type { ... } from '@mission-control/tui/state'` for state types and loads the runtime mount via `await import('@mission-control/tui/create-chat-tui')` only inside the `if (useTui)` branch. The replay overlay is lazy-loaded the same way via `await import('@mission-control/tui/replay-overlay')`.

The CLI provides `ChatAppActions` implementations (wrapping `interactive-chat-actions.ts`, `agents-disabled-config.ts`, `agents-model-overrides-config.ts`) and the `MissionControlServices` instance to `createChatTui` via `ChatTuiRuntimeOptions`. The TUI package receives them as injected callbacks and a structural interface, so it never imports CLI runtime code.

For the TUI handle pattern, keyboard routing, Solid JSX setup, ChatStore internals, output rendering, screen layout, markdown pipeline, diff renderer, and all component/platform details, see `apps/tui/AGENTS.md`.

## Error Handling

Provider errors (insufficient balance, rate limit, auth failure, network error) are caught at three layers:

1. **Fallback provider path** (`interactive-chat-prompt-turn.ts`): `result.status === 'failed'` writes `Error: <message>` to chatOutput instead of throwing
2. **Coding agent path** (`interactive-coding-agent.ts`): `settleReceipt` failed case writes to output instead of throwing; turn `done` promise has `.catch()`
3. **Main loop** (`interactive-chat.ts`): `try-catch` around `runChatAction` as safety net

JSON error responses from providers (e.g., `{"error":{"message":"..."}}`) are parsed in `openai-compatible-errors.ts` via `extractReadableErrorMessage()` to extract the human-readable message.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Executable entry, help, version | `src/index.tsx` | Package `bin` maps `mc` and `mctrl` to `./dist/index.js`. |
| Background agent runner | `src/commands/chat-agent-runner.ts` | `startChatAgentRunner` replaces the imperative `for(;;)` loop with an async state machine over the store event queue; preserves the G1-G10 sequential guarantees. `createStoreChatOutput` adapts the store to the `ChatOutput` interface. |
| Top-level flags and modes | `src/args.ts` | Keep command/mode string unions explicit. Default mode is `'tui'` (opentui); `--no-tui`/`--json`/`--jsonl` select the non-interactive renderers. `--profile <name>` is long-only: it selects a user-scope config profile (`parseProfileName`, regex `^[a-z0-9][a-z0-9_-]{0,63}$`); auth's `-p` short flag is provider shorthand, not a profile alias. `--profile` threads through `run` and `mcp list/test/add/remove --scope user`; non-MCP commands (auth/session/models/agents) reject or ignore it safely. |
| Run and graph args | `src/run-args.ts` | Owns `--json`, `--jsonl`, provider/model, native, graph, `--workspace`, `--session`, `--engine` flags. |
| Auth args | `src/auth-args.ts` | Delegates into `src/commands/auth*.ts`. |
| Session args | `src/session-args.ts` | Delegates into `src/commands/session.ts`. |
| Runtime orchestration | `src/commands/run-agent.ts` | Chooses chat/non-interactive paths, provider setup, permissions, renderers, workspace root resolution (`--workspace` > `MCTRL_WORKSPACE` > `detectWorkspaceRoot()`). |
| Interactive chat | `src/commands/interactive-chat*.ts` | Terminal input, slash commands, model picker, approval broker. Non-TTY fallback path. `useTui` gates the opentui TUI on `process.stdin.isTTY`. Lazy-loads `@mission-control/tui/create-chat-tui` only when TUI is active. |
| Command parsing | `src/commands/chat-commands.ts` | parseChatLine -> ChatLineAction |
| Interactive chat actions | `src/commands/interactive-chat-actions.ts` | CLI side-effect adapters (`loadDashboardAgentEntries`, `loadMissionPanelRows`, `toggleAgentDisabled`, `setAgentModelOverride`) injected as `ChatAppActions` into the TUI. Imports agents-command, chat-commands, interactive-coding-agent. |
| Model discovery | `src/commands/model-discovery.ts` | Per-provider API calls for live model lists |
| Models command | `src/commands/models.ts` | `mc models` - runtime catalog + discovery union |
| Provider factory | `src/commands/provider-factory.ts` | Maps capability to adapter |
| Runtime catalog | `packages/config/src/models-dev-runtime.ts` | Fetches models.dev with 5min disk cache |
| Output modes | `src/ui/renderers.ts` | Plain, TUI (buffered summary), and JSON renderer contracts. `AgentUIRenderer` interface lives here. |
| CLI package targets | `package.json`, `project.json` | `tsc` build, verbose Vitest, Nx `cli:*` targets. |
| ChatOutput extensions | `src/commands/interactive-chat-io.ts` | Optional `setAgentStatus`/`clearAgentStatus`/`showApproval`/`hideApproval` methods. Re-exports `ChatInputEvent` type from `@mission-control/tui/state`. |
| Workspace resolution | `src/commands/run-agent.ts` (`resolveWorkspaceRoot`, `detectWorkspaceRoot`) | `--workspace <path>` flag wins, then `MCTRL_WORKSPACE` env var, then `.git`/workspaces heuristic walking up from `process.cwd()`. |
| Session store fix | `src/commands/run-agent-session.ts` | `createsTransientSessionStore` includes the `'tui'` mode so the graph path (with tools) is always used. |
| Mission control services | `src/commands/mission-control-services.ts` | CLI session-owned runtime manager (lifecycle, job manager, registry). Passed to TUI via `MissionControlServicesLike` structural interface. |
| Welcome data factory | `src/commands/welcome-data.ts` | Imports `../index.js` (CLI entry) + session-catalog. Types moved to `@mission-control/tui/state`. |
| Agents config (disabled) | `src/commands/agents-disabled-config.ts` | Writes agent config to disk; used by CLI runtime. Components call it via injected `ChatAppActions.toggleAgentDisabled`. |
| Agents config (model overrides) | `src/commands/agents-model-overrides-config.ts` | Writes model override config; used by CLI runtime. Components call it via injected `ChatAppActions.setAgentModelOverride` + `isValidModelPattern`. |
| Retryable tool errors | `packages/core/src/tools/read-tools-errors.ts` | Repo tool failures are `retryable: true` - the model can adjust and retry instead of the run dying. |
| TUI components, platform, store, mount | see `apps/tui/AGENTS.md` | Solid/OpenTUI components, keymap platform, `ChatStore`, `createChatTui`, markdown/diff renderers, clipboard, terminal viewport - all live in `apps/tui`. |

## Conventions

- Keep CLI behavior behind `apps/cli`; do not move command-line parsing or terminal rendering into `packages/core`.
- Treat help text, JSON, JSONL, and plain output as user-facing contracts. Update focused tests when strings, event ordering, or redaction changes.
- Normal prompts can run through the deterministic local provider or the OpenAI-compatible adapter when configured. `$skill <name>` and `/<skill-name>` load a discovered skill's `SKILL.md` body as the next user prompt (real skill loading, replacing the old scaffold recorder); the loaded body is inert text and does not call Codex host skills or spawn agents on its own. A real tool-calling provider is required for loaded skills to drive agentic behavior - the default `local/local-echo` provider does not call tools.
- Store auth through `auth-store.ts`; never print raw API keys, OAuth tokens, or multi-field credentials.
- Argument parsing stays parse-only. Runtime effects belong in command modules.
- Renderer code should consume protocol/core events, not private runtime fields.
- The noninteractive renderers consume already-redacted output (provider/tool output is redacted upstream in `packages/core`). Never read raw provider or tool structured output in a renderer.
- Legacy component test-renderer packages are intentionally not dependencies. Test renderer logic via pure exported helpers or OpenTUI/Solid headless render paths (in `apps/tui`). Never mount the full TUI tree in a unit test.
- Interactive TUI layout must derive from `TerminalViewport { columns, rows }` via `useTerminalViewport()` (now in `apps/tui/src/platform/`). Direct `process.stdout.columns/rows` reads are reserved for noninteractive stdout renderers (`src/ui/renderers.ts`) and low-level terminal seams, not interactive code.
- The CLI must never statically import `@opentui/*` or `solid-js`. All TUI access goes through `@mission-control/tui` lazy imports inside the `useTui` branch so `mc --no-tui` stays opentui-free.
- `exactOptionalPropertyTypes` is active - use conditional spreads for optional props (`...(cond ? { prop: val } : {})`), and when sourcing opentui props from `| undefined` helpers, assign to a local first and narrow before spreading.
- User input echoed to outputText uses `You: ` prefix so `parseMessageBlocks` can classify it.
- Error messages use `Error: ` prefix for the same reason.
- Slash commands that start with `/` are NOT echoed to outputText (they're system commands, not conversation).
- The `controlsPrompt` flag is set to `true` on the opentui `ChatOutput` (see `interactive-chat-io.ts`) so the imperative loop calls `renderPrompt()` (no-op) instead of writing `> ` to outputText. The prompt is rendered by `ChatApp`'s input area.

## Tests

- Colocated `*.test.ts` files under `src` are the package test surface.
- For argument changes, update `args.test.ts`, `run-agent-*`, `auth-*`, or `session.test.ts` as appropriate.
- For renderer/output changes, update `src/ui/renderers.test.ts` and the affected command-mode tests.
- Integration tests (`run-agent-chat.test.ts`) inject scripted `ChatInput`/`ChatOutput` via options, bypassing the opentui TUI entirely.
- The interactive TUI is covered by `interactive-chat-terminal-input.test.ts` for the terminal fallback plus focused tests in `apps/tui` (create-chat-tui, ChatApp, component, and keymap tests); use manual tmux QA for full runtime checks.
- Model command tests (`run-agent-model-command.test.ts`) verify `/model` parsing and selection logic.
- When modifying the interactive TUI runtime, always run tmux QA: start CLI, type a prompt, verify response, test `/exit` and Ctrl+C.
- Run focused CLI tests with `NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run cli:test` or `pnpm exec vitest run apps/cli/src/<file>.test.ts`.

## Anti-Patterns

- Do NOT statically import `create-chat-tui`, TUI components, platform code, or `@opentui/*` in `apps/cli`. The CLI reaches the TUI through `@mission-control/tui` lazy imports only.
- Do NOT use `process.stdin.setRawMode()` directly - opentui's `createCliRenderer` manages raw mode (in `apps/tui`).
- Do NOT add deprecated terminal UI companion packages or compatibility input/select layers. All components are custom-built on opentui intrinsics (in `apps/tui`).
- Do NOT import deprecated terminal UI frameworks. OpenTUI with Solid bindings is the only terminal renderer for TUI mode.
- Do NOT call `console.log` in TUI mode - the renderer may patch the stream. Use `process.stderr.write()` for debugging.
- Do NOT remove the non-TUI terminal fallback path - tests depend on it via scripted input injection.
- Do NOT bypass `createAllowPermissionDecision` or approval plumbing for write-capable command paths.
- Do NOT add shell-string command execution in CLI code.
- Do NOT make demo-only provider/model metadata look like an implemented provider adapter.
- Do NOT edit `dist`; it is generated by `tsc`.
- Do NOT mutate `ChatStore` state directly from CLI code. The store is owned by `apps/tui`; CLI drives it through the `ChatTuiHandle` contract and injected callbacks.
