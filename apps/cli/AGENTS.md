# CLI Agent Guide

## Overview

`apps/cli` owns the `mctrl` command-line application: argument parsing, command orchestration, auth/model/session commands, terminal interaction, and interactive chat rendered via Ink (React for CLI).

The interactive chat uses Ink v7 + React 19 for terminal rendering, bridged to the existing imperative chat loop via `useSyncExternalStore`. The bridge pattern allows the imperative `runInteractiveChatSession` loop to stay unchanged while Ink owns all keyboard input and screen output.

## Ink Chat Architecture

### Bridge Pattern

```
┌──────────────────────────────────────────────────────────────┐
│  runInteractiveChatSession()  (imperative for(;;) loop)      │
│    ↓ await chatInput.read()                                  │
│    ↓ chatOutput.write(text)                                  │
│    ↓ selectModel(choices)                                    │
├──────────────────────────────────────────────────────────────┤
│  InkChatBridge  (ink-chat-bridge.tsx)                        │
│    ┌─ waitForEvent() → Promise<ChatInputEvent>              │
│    ├─ emitOutput(text) → appends to outputText               │
│    ├─ showModelPicker(choices) → Promise<selection>          │
│    └─ unmount()                                              │
├──────────────────────────────────────────────────────────────┤
│  Ink render(<ChatRoot />)  (React component tree)            │
│    ┌─ useInput(handleInput)  ← all keyboard events           │
│    ├─ useSyncExternalStore   ← bridge core snapshot          │
│    └─ ChatRoot renders:                                      │
│         message blocks → slash menu → separator → input      │
│         → status bar                                         │
└──────────────────────────────────────────────────────────────┘
```

### Core State (InkChatBridgeCore)

All mutable state lives in the bridge core. React reads it via `useSyncExternalStore` and never directly mutates it. `publishSnapshot()` creates a new snapshot object and notifies all listeners.

| Field | Purpose |
|---|---|
| `inputBuffer` | Current text being typed by the user |
| `outputText` | Accumulated chat output (system messages, user echoes, assistant responses, errors) |
| `menuState` | Slash command autocomplete selection state |
| `eventQueue` | Pending ChatInputEvents when no waiter exists |
| `eventWaiters` | Promise resolvers waiting for the next input event |
| `modelPickerActive` | Whether the model picker overlay is showing |
| `modelPickerChoices` | Model choices for the active picker |
| `modelPickerKeypress` | Search/navigation state for the model picker |
| `modelPickerResolve` | Promise resolver for the model picker selection |

### Input Handling (handleInput)

All keyboard events flow through `handleInput(core, input, key)`. Priority:

1. **Model picker mode** — when `modelPickerActive`, route to `handleModelPickerInput` (arrows, search, Enter, Ctrl+C)
2. **Ctrl+C** — emit `{ type: 'interrupt' }` event
3. **Arrow keys** (when input starts with `/`) — navigate slash command menu
4. **Enter** — detect via `key.return || input.includes('\r') || input.includes('\n')` (Ink batches multi-char input like `"hello\r"` into a single call), resolve slash commands if applicable, enqueue line event, echo user input to outputText
5. **Backspace** — remove last character from inputBuffer
6. **Printable chars** — append to inputBuffer

**Critical Ink gotcha**: Ink's `useInput` delivers multi-character input as a single string with `key.return = false`. For example, typing "hello" then pressing Enter arrives as `input = "hello\r"` in one call. Always check `input.includes('\r') || input.includes('\n')` in addition to `key.return`.

### Output Rendering

The output text is parsed into `ChatBlock` objects by `parseMessageBlocks()`. Each block has a `kind` that routes to a dedicated renderer:

| Prefix in outputText | Block kind | Renderer |
|---|---|---|
| `You: ` | user | flat row, cyan left bar, raw text |
| `Assistant: ` | assistant | `<Markdown>` via `MarkdownPanel` (green bar, width 1) |
| `Thinking: ` | thinking | `<Markdown>` via `MarkdownPanel` (magenta bar, width 2, italic-dim theme) |
| `Error: ` | error | flat row, red left bar, red text |
| tool preview/output lines | tool | `<ToolCard>` (rounded border, diff-aware) |
| (anything else) | system | flat dim text, no left bar |

The markdown pipeline (`src/components/markdown/`) is Ink-native: `Markdown.tsx` walks `marked` tokens into a serializable IR (`InlineRun`/`RenderLine`/`RenderBlock`), styled by `theme.ts` (`darkTheme`), with code-block syntax highlighting from `highlight.ts` (T5) and streaming-unsafe markdown healing from `stream.ts` (T3). A 64-entry LRU cache (`getCachedBlocks`) keys on `(text, width, streaming, theme)`. Wrapping uses `wrap-ansi` with `trim:false` so every character survives; CJK double-width glyphs are counted as 2 columns by `string-width`/`get-east-asian-width`, so lines never overflow the target width.

`parseMessageBlocks` splits `outputText` WITHOUT dropping blank lines: interior blanks survive as markdown paragraph separators (so `Assistant: para1\n\npara2` stays one block), and only leading/trailing empties are trimmed. Continuation absorption keeps multi-line assistant/thinking messages as a single markdown unit (absorbing only `system`-classified lines), while tool blocks keep the broader `!isStrongBoundary` absorption. Tool-preview lines (`Edit preview for`, `+++`, `---`, etc.) are strong-enough boundaries that they always start a new `tool` block.

`MessageBlock` routes each `ChatBlock`: assistant/thinking → `MarkdownPanel` (a colored bar whose row count matches the rendered markdown line count, plus the `<Markdown>` tree); tool → `<ToolCard>`; user/error/system → the legacy flat row. When the trailing window budget is exceeded, `selectTrailingBlocks` drops markdown blocks whole (tail-slicing mid-block can split a code fence) and tail-slices non-markdown blocks, marking them `ChatBlock.truncated: true`. The `toolOutputExpanded` flag (Ctrl+O toggle) collapses `<ToolCard>` to a header-only `> title (N lines)` view.

The diff renderer (`src/components/diff/`) classifies mctrl's no-line-number format (`-old`/`+new`/`--- a/`/`+++ b/`/`@@`) via `render-diff.ts` and renders green/red/cyan rows with inverse intra-line highlighting through `DiffView.tsx`. `ToolCard` auto-detects diff content via `hasDiffContent` and routes accordingly; prose tool output falls back to plain yellow lines.

### Screen Layout (top to bottom)

```
┌─ System messages (dim text, no left bar) ──────┐
│  mission-control chat                            │
│  provider: zai-coding-plan                       │
│  Press Ctrl+C twice or /exit to exit             │
└──────────────────────────────────────────────────┘

┌─ User message (cyan left bar) ─────────────────┐
│ █ Hello, what is 2+2?                           │
└──────────────────────────────────────────────────┘
┌─ Assistant message (green left bar, dim) ───────┐
│ █ 2 + 2 = 4                                      │
└──────────────────────────────────────────────────┘
┌─ Error message (red left bar) ──────────────────┐
│ █ Insufficient balance...                        │
└──────────────────────────────────────────────────┘

  (slash command menu — shown only when input starts with /)

────────────────────────────────────────── ← separator line (dim ─)
>  Type a message or / for commands      ← input area (cyan > prompt)

provider: X | model: Y | session: Z      ← status bar (dim)
```

### Slash Command Autocomplete

When the input buffer starts with `/`, a filtered command menu renders between the message blocks and the separator line. The menu uses the existing `createSlashCommandMenuView` from `interactive-chat-command-menu.ts`.

- Typing filters commands (e.g., `/ex` matches `/exit`)
- Arrow Up/Down navigates the selection
- Enter resolves the partial match via `resolveSlashCommandMenuSubmission()` before submitting
- The selected command is highlighted with `>` marker and blue background

### Model Picker Overlay

When `/model` is invoked, `showModelPicker(choices)` is called on the bridge. This switches `modelPickerActive` to true, causing ChatRoot to render a full-screen overlay replacing the normal output/menu/input/status layout.

The model picker reuses `ProviderPromptKeypress` state machine (the same one used by the terminal model selector and auth provider prompts). Arrow keys are converted from Ink's boolean flags (`key.upArrow`) to escape sequences (`\u001b[A`) for the reducer.

### Error Handling

Provider errors (insufficient balance, rate limit, auth failure, network error) are caught at three layers:

1. **Fallback provider path** (`interactive-chat-prompt-turn.ts`): `result.status === 'failed'` writes `Error: <message>` to chatOutput instead of throwing
2. **Coding agent path** (`interactive-coding-agent.ts`): `settleReceipt` failed case writes to output instead of throwing; turn `done` promise has `.catch()`
3. **Main loop** (`interactive-chat.ts`): `try-catch` around `runChatAction` as safety net

JSON error responses from providers (e.g., `{"error":{"message":"..."}}`) are parsed in `openai-compatible-errors.ts` via `extractReadableErrorMessage()` to extract the human-readable message.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Ink bridge (core state, input, render) | `src/commands/ink-chat-bridge.tsx` | Heart of the interactive chat |
| Ink model selector adapter | `src/commands/ink-model-selector.ts` | Maps bridge.showModelPicker to ModelSelector |
| Ink ChatInput adapter | `src/commands/ink-chat-input.ts` | Delegates to bridge.waitForEvent |
| Ink ChatOutput adapter | `src/commands/ink-chat-output.ts` | Delegates to bridge.emitOutput |
| Ink components | `src/components/*.tsx` | TextInput, SlashCommandMenu, ModelSelector, MessageList, StatusBar, ApprovalPrompt |
| Markdown renderer | `src/components/markdown/Markdown.tsx` | Ink-native markdown: token walker → IR (`InlineRun`/`RenderLine`/`RenderBlock`) → `<Box>`/`<Text>`. Pure helpers (`getCachedBlocks`, `reflowRuns`, `renderInlineToRuns`, `computeTableColumnWidths`) are exported for unit tests. 64-entry LRU cache. |
| Markdown theme | `src/components/markdown/theme.ts` | `darkTheme` (14 element styles + `highlightCode` slot), `noColorTheme`. `InkTextStyle` = subset of Ink `<Text>` props. |
| Markdown streaming healer | `src/components/markdown/stream.ts` | `streamBlocks` heals incomplete markdown (open `**`, ```` ``` ```` fence) via `remend` and splits live input into renderable blocks. Never throws. |
| Code highlighting | `src/components/markdown/highlight.ts` | `highlightCode` tokenizes via `cli-highlight` with a sentinel-encoded custom theme; scope→color table; zero raw ANSI leakage. |
| Diff renderer | `src/components/diff/` | `render-diff.ts` classifies mctrl no-line-number diffs; `DiffView.tsx` renders green/red/cyan with inverse intra-line spans. `kindStyle`/`splitLineSpans` exported for tests. |
| Tool card | `src/components/ToolCard.tsx` | Bordered card; `hasDiffContent` auto-routes to `<DiffView>` or yellow prose lines; `expanded` prop collapses to header. |
| Executable entry, help, version | `src/index.tsx` | Package `bin` maps `mctrl` to `./dist/index.js`. |
| Top-level flags and modes | `src/args.ts` | Keep command/mode string unions explicit. |
| Run and graph args | `src/run-args.ts` | Owns `--json`, `--jsonl`, provider/model, native, graph, `--workspace`, `--session`, `--engine` flags. |
| Auth args | `src/auth-args.ts` | Delegates into `src/commands/auth*.ts`. |
| Session args | `src/session-args.ts` | Delegates into `src/commands/session.ts`. |
| Runtime orchestration | `src/commands/run-agent.ts` | Chooses chat/non-interactive paths, provider setup, permissions, renderers, workspace root resolution (`--workspace` > `MCTRL_WORKSPACE` > `detectWorkspaceRoot()`). |
| Interactive chat | `src/commands/interactive-chat*.ts` | Terminal input, slash commands, model picker, approval broker. Non-TTY fallback path. |
| Command parsing | `src/commands/chat-commands.ts` | parseChatLine → ChatLineAction |
| Slash command menu state | `src/commands/interactive-chat-command-menu.ts` | createSlashCommandMenuView, resolveSlashCommandMenuSubmission |
| Model discovery | `src/commands/model-discovery.ts` | Per-provider API calls for live model lists |
| Models command | `src/commands/models.ts` | `mctrl models` — runtime catalog + discovery union |
| Provider factory | `src/commands/provider-factory.ts` | Maps capability → adapter |
| Runtime catalog | `packages/config/src/models-dev-runtime.ts` | Fetches models.dev with 5min disk cache |
| Output modes | `src/ui/renderers.ts` | Plain, Ink, and JSON renderer contracts. |
| CLI package targets | `package.json`, `project.json` | `tsc` build, verbose Vitest, Nx `cli:*` targets. |
| Agent spinner | `src/commands/ink-chat-bridge.tsx` (AgentSpinner) | Braille spinner (`⠋⠙⠹…`) at 80ms; shows "Thinking…" / "Running X…" via `ChatOutput.setAgentStatus`. |
| Approval overlay | `src/commands/ink-chat-bridge.tsx` (handleApprovalInput) | Arrow-key Up/Down/Enter/Ctrl+C navigation; `ChatOutput.showApproval`/`hideApproval`. |
| ChatOutput extensions | `src/commands/interactive-chat-io.ts` | Optional `setAgentStatus`/`clearAgentStatus`/`showApproval`/`hideApproval` methods. |
| Workspace resolution | `src/commands/run-agent.ts` (`resolveWorkspaceRoot`, `detectWorkspaceRoot`) | `--workspace <path>` flag wins, then `MCTRL_WORKSPACE` env var, then `.git`/workspaces heuristic walking up from `process.cwd()`. |
| StatusBar render surface | `src/components/StatusBar.tsx` | Renders provider/model/variant/project/branch/session; `formatStatus` is exported for unit tests. |
| Session store fix | `src/commands/run-agent-session.ts` | `createsTransientSessionStore` includes `'ink'` mode so the graph path (with tools) is always used. |
| Retryable tool errors | `packages/core/src/tools/read-tools-errors.ts` | Repo tool failures are `retryable: true` — the model can adjust and retry instead of the run dying. |

## Conventions

- Keep CLI behavior behind `apps/cli`; do not move command-line parsing or terminal rendering into `packages/core`.
- Treat help text, JSON, JSONL, and plain output as user-facing contracts. Update focused tests when strings, event ordering, or redaction changes.
- Normal prompts can run through the deterministic local provider or the OpenAI-compatible adapter when configured. `$skill <name>` and `/<skill-name>` load a discovered skill's `SKILL.md` body as the next user prompt (real skill loading, replacing the old scaffold recorder); the loaded body is inert text and does not call Codex host skills or spawn agents on its own. A real tool-calling provider is required for loaded skills to drive agentic behavior — the default `local/local-echo` provider does not call tools.
- Store auth through `auth-store.ts`; never print raw API keys, OAuth tokens, or multi-field credentials.
- Argument parsing stays parse-only. Runtime effects belong in command modules.
- Renderer code should consume protocol/core events, not private runtime fields.
- The markdown/diff/ToolCard renderers consume already-redacted `outputText` (provider/tool output is redacted upstream in `packages/core`). Never read raw provider or tool structured output in a renderer.
- `react-test-renderer` is intentionally not a dependency. Test renderer logic via the pure exported helpers (`getCachedBlocks`/`reflowRuns`/`kindStyle`/`hasDiffContent`) or Ink's headless `renderToString({columns})`. Never mount a full React tree in a unit test.
- Visible-width math (wrapping, table columns, bar row counts) counts East Asian Wide glyphs as 2 columns — `wrap-ansi` relies on `string-width`/`get-east-asian-width`, so CJK never overflows.
- The bridge core is the single source of truth. React components are read-only views of the snapshot.
- `useSyncExternalStore` requires `getSnapshot()` to return a referentially stable object — `publishSnapshot()` always creates a new object.
- Ink's `useInput` batches multi-char input. Always check for `\r`/`\n` inside the `input` string, not just `key.return`.
- `exactOptionalPropertyTypes` is active — use conditional spreads for optional props (`...(cond ? { prop: val } : {})`).
- User input echoed to outputText uses `You: ` prefix so `parseMessageBlocks` can classify it.
- Error messages use `Error: ` prefix for the same reason.
- Slash commands that start with `/` are NOT echoed to outputText (they're system commands, not conversation).
- The `controlsPrompt` flag is set to `true` in `ink-chat-input.ts` so the imperative loop calls `renderPrompt()` (no-op) instead of writing `> ` to outputText. The prompt is rendered by ChatRoot's input area.

## Tests

- Colocated `*.test.ts` files under `src` are the package test surface.
- For argument changes, update `args.test.ts`, `run-agent-*`, `auth-*`, or `session.test.ts` as appropriate.
- For renderer/output changes, update `src/ui/renderers.test.ts` and the affected command-mode tests.
- Integration tests (`run-agent-chat.test.ts`) inject scripted `ChatInput`/`ChatOutput` via options, bypassing Ink entirely.
- The bridge itself is tested via `interactive-chat-terminal-input.test.ts` (legacy terminal path) and manual tmux QA.
- Model command tests (`run-agent-model-command.test.ts`) verify `/model` parsing and selection logic.
- When modifying the bridge, always run tmux QA: start CLI, type a prompt, verify response, test `/exit` and Ctrl+C.
- Run focused CLI tests with `NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run cli:test` or `pnpm exec vitest run apps/cli/src/<file>.test.ts`.

## Anti-Patterns

- Do NOT mutate bridge core state directly from React components — always go through `handleInput`.
- Do NOT use `process.stdin.setRawMode()` directly — Ink manages raw mode via `useInput`.
- Do NOT add companion packages (ink-text-input, ink-select-input) — they don't support Ink 7. All components are custom-built.
- Do NOT call `console.log` in Ink mode — Ink patches console. Use `process.stderr.write()` for debugging.
- Do NOT remove the non-Ink terminal fallback path — tests depend on it via scripted input injection.
- Do NOT bypass `createAllowPermissionDecision` or approval plumbing for write-capable command paths.
- Do NOT add shell-string command execution in CLI code.
- Do NOT make demo-only provider/model metadata look like an implemented provider adapter.
- Do NOT edit `dist`; it is generated by `tsc`.
