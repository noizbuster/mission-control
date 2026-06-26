# CLI Agent Guide

## Overview

`apps/cli` owns the `mctrl` command-line application: argument parsing, command orchestration, auth/model/session commands, terminal interaction, and interactive chat rendered via opentui (`@opentui/react` over a node:ffi-loaded native core on Node 26.3+).

The interactive chat uses `@opentui/react` + React 19 for terminal rendering, bridged to the existing imperative chat loop via `useSyncExternalStore`. The bridge pattern allows the imperative `runInteractiveChatSession` loop to stay unchanged while opentui owns all keyboard input and screen output.

## opentui Chat Architecture

### Native core via node:ffi (Node 26.3+)

opentui ships a Zig native core (`libopentui.so` / `.dylib` / `.dll`) accessed through an FFI backend. opentui's `loadBackend()` tries `bun:ffi` under Bun and `node:ffi` under Node, falling back to an unsupported backend on failure. With Node 26.3+, the `node:ffi` module is available and `createNodeBackend` handles dlopen, callbacks, and pointer arithmetic natively. No third-party FFI library or pnpm patch is required. Run the CLI with `--experimental-ffi` so `node:ffi` loads.

The struct layer (`bun-ffi-structs`) is pure JavaScript — it computes offsets/sizes with arithmetic and packs into `ArrayBuffer` via `DataView`. Only its `ptr()` and `toArrayBuffer()` primitives touch native code, and both route through the same node:ffi backend. No per-struct rewrite is needed.

### Bridge Pattern

```
┌──────────────────────────────────────────────────────────────┐
│  runInteractiveChatSession()  (imperative for(;;) loop)      │
│    ↓ await chatInput.read()                                  │
│    ↓ chatOutput.write(text)                                  │
│    ↓ selectModel(choices)                                    │
├──────────────────────────────────────────────────────────────┤
│  OpenTuiChatBridge  (opentui-chat-bridge.tsx)                │
│    ┌─ waitForEvent() → Promise<ChatInputEvent>              │
│    ├─ emitOutput(text) → appends to outputText               │
│    ├─ showModelPicker(choices) → Promise<selection>          │
│    └─ unmount()                                              │
├──────────────────────────────────────────────────────────────┤
│  ChatRoot  (React tree over opentui intrinsics)              │
│  OWNERSHIP SPLIT - editing vs non-editing state              │
│    ┌─ <ChatInputTextarea> → native <textarea>                │
│    │    TextareaRenderable owns text+cursor+selection+IME    │
│    │    onKeyDown → bridgeTextareaKeyDown (raw KeyEvent,     │
│    │      preventDefault per handled chord)                  │
│    │    onSubmit → bridgeSubmit / onContentChange → mirror   │
│    ├─ <ChatTranscript> → native <scrollbox>                  │
│    │    ScrollBoxRenderable owns output scroll + windowing   │
│    │    scrollboxRef → imperative Home/End/PgUp/PgDn         │
│    └─ global useKeyboard → handleInput (OVERLAY SINK only;   │
│         textarea focused ⇒ early-return except Ctrl+C)      │
│    useSyncExternalStore ← bridge core snapshot               │
└──────────────────────────────────────────────────────────────┘
```

Two native opentui renderables own what the old hand-rolled code used to. `<ChatInputTextarea>` wraps the native `<textarea>` (`TextareaRenderable`): it owns the editable text, the cursor, the selection, and IME composition. `<ChatTranscript>` wraps the native `<scrollbox>` (`ScrollBoxRenderable`): it owns output scrolling and windowing. The bridge core no longer tracks cursor, composition, or transcript scroll. It owns the non-editing state: overlay modes, menus, history, the `inputBuffer` mirror, and the event queue.

Editing keys never reach the bridge. Printable input, backspace, arrow movement, word-move, the real cursor, and IME composition are all native `TextareaRenderable` behavior. The bridge intercepts only via the textarea's `onKeyDown` (`bridgeTextareaKeyDown`), where each handled chord calls `key.preventDefault()` first so the native binding is suppressed before the bridge logic runs.

`mountOpenTui` (in `src/platform/opentui-renderer.ts`) is the mount/unmount seam. It dynamic-imports `createCliRenderer` from `@opentui/core` and `createRoot` from `@opentui/react`, mounts the React tree, and returns `{ renderer, root, unmount }`. The dynamic imports keep both packages out of the eager module graph for non-TUI CLI runs (plain/JSON), so `mctrl --no-tui` never loads the native renderer. `unmount()` tears down both the React root and the renderer and is idempotent.

### KeyEvent Adapter

opentui's `useKeyboard` delivers one `KeyEvent` per physical keypress. The adapter in `src/platform/key-event-adapter.ts` (`createKeyEventAdapter` / `adaptKeyEvent`) reproduces Ink's `{ input: string, key: Key }` assembly rules so the surviving `handleInput` overlay handlers (approval, question, model picker, level picker, rename, ABG overlay) keep their Ink-era keystroke checks:

- `key.*` boolean flags derive from the key `name` (`up` → `upArrow`, etc.).
- `input` for `ctrl+<letter>` is the letter (so `handleInput`'s `input === 'c'` Ctrl+C check still fires).
- `input` is the `sequence` otherwise, forced to `''` for non-alphanumeric key names (arrows, tab, backspace, delete, pageup/down, home, end, f-keys).
- A leading ESC (`\x1b`) is stripped (matters for the lone Escape key).

The adapter is kept on purpose, but its scope shrank in the native-textarea port. Editing keys (printable, backspace, arrows, word-move, Enter-submit, IME) no longer flow through it; they are native `TextareaRenderable` behavior, and the chords, scroll, and history that the bridge still cares about ride the textarea's `onKeyDown` (`bridgeTextareaKeyDown`) as a raw `KeyEvent` with its own `preventDefault`. The adapter now feeds only the global `useKeyboard` overlay sink in `ChatRoot`, which runs when the textarea is blurred (an overlay is active) plus the always-routed Ctrl+C. `InkKeyShape` is the structural mirror of Ink's 20-field `Key` type, re-exported from the bridge so the bridge test suites import it from one module.

### JSX: per-file `@jsxImportSource` pragma

opentui's lowercase intrinsics (`<text>`, `<box>`, `<span>`, ...) collide with React's inherited DOM/SVG intrinsics (`text` is SVG; `span`, `code`, `select` are HTML). A global `declare module 'react' { namespace JSX }` augmentation would cause "subsequent property declarations must have same type" errors on the overlapping names. Instead, every `.tsx` file that uses opentui intrinsics starts with a per-file pragma:

```tsx
/** @jsxImportSource @opentui/react */
```

opentui's `jsx-runtime.d.ts` re-exports `jsx`/`jsxs`/`Fragment` from `react/jsx-runtime` at runtime (zero behavior change) but loads opentui's own JSX namespace at type time, where intrinsics override the inherited DOM types cleanly. Under this pragma, `JSX.Element` is `React.ReactNode` (not `ReactElement`), so opentui-pragmatic component return types must be annotated `: React.ReactNode`. Ink color/attribute props (`color`, `backgroundColor`, `bold`, `dimColor`, `inverse`) do not exist on opentui intrinsics; they translate to `fg`/`bg`/`attributes` via `toOpenTuiColor` / `toOpenTuiAttributes` (`src/platform/opentui-types.ts`).

### Core State (OpenTuiChatBridgeCore)

All mutable state lives in the bridge core. React reads it via `useSyncExternalStore` and never directly mutates it. `publishSnapshot()` creates a new snapshot object and notifies all listeners.

Editing state does NOT live here. The editable text, cursor, and selection live in the `TextareaRenderable`, reached via `textareaRef`. Output scroll lives in the `ScrollBoxRenderable`, reached via `scrollboxRef`. Clipboard access lives in a `clipboardService` built from the renderer. All three are created in `ChatRoot` and threaded into the bridge handlers, not stored on the core.

| Field | Purpose |
|---|---|
| `inputBuffer` | Mirror of the textarea's `plainText`, kept in sync by `bridgeContentChange`. The textarea is the source of truth; the bridge never appends to this directly. |
| `outputText` | Accumulated chat output (system messages, user echoes, assistant responses, errors) |
| `menuState` | Slash command autocomplete selection state |
| `fileAutocomplete` | `@`-path autocomplete state |
| `history` | Chat input history for Up/Down recall |
| `eventQueue` | Pending ChatInputEvents when no waiter exists |
| `eventWaiters` | Promise resolvers waiting for the next input event |
| `submitting` | IME re-entrancy guard inside `bridgeSubmit` (blocks a fast double-Enter) |
| `lastEscTimestamp` | Double-Escape window timing |
| overlay flags (`modelPickerActive` / `levelPickerActive` / `approvalActive` / `questionActive` / `renameModeActive` / `abgOverlayActive`) | Any of these true blurs the textarea so its keys reach the global overlay sink. |

### Input Handling (handleInput)

Input now splits across two sinks. Raw editing is native; the bridge intercepts only chords, scroll, history, and overlays.

**`bridgeTextareaKeyDown(core, key, textareaRef, scrollboxRef)`** is the textarea's `onKeyDown`. Every input-area key routes through it as a raw `KeyEvent` (which carries its own `preventDefault`). Each handled chord calls `key.preventDefault()` first so the native binding is suppressed before the logic runs. It owns: plain Enter to submit (a redundant safety net over the `return -> submit` keyBinding override), Tab to complete the active `@`-file selection, Escape (interrupt while generating, clear the buffer, close autocomplete, or open the double-Esc exit window), Ctrl+G (toggle ABG overlay), Ctrl+Z (suspend), Ctrl+D (delete char, or interrupt at an empty buffer), Ctrl+T (toggle thinking view), Ctrl+O (toggle tool expand), Ctrl+P (model cycle), Ctrl+E (external editor), Ctrl+R (rename entry), Ctrl+V (image paste), Home/End/PgUp/PgDn (imperative scrollbox scroll), and Up/Down (history recall at the buffer bounds, otherwise a native cursor move) plus slash/workflow menu navigation. Ctrl+C is deliberately NOT handled here; it routes through the global sink to avoid a double-enqueue race.

**`bridgeSubmit(core, textareaRef)`** is the textarea's `onSubmit` (and the Enter branch above). It snapshots `textareaRef.current.plainText` synchronously, then defers the actual enqueue twice (`setTimeout` nested twice) so a Ctrl+C during the IME defer window cannot enqueue an empty line. A `submitting` guard blocks a fast double-Enter. The `#`-workflow and `/`-slash completion-into-buffer cases return without enqueuing a line.

**`bridgeContentChange(core, text)`** is the textarea's `onContentChange`. It mirrors the new text into `core.inputBuffer` and refreshes the slash/workflow/`@`-autocomplete menus. It only keeps the mirror in sync; the textarea remains the source of truth.

**`handleInput(core, input, key)`** is now overlay-routing only. It is reached via the global `useKeyboard` sink when the textarea is blurred (an overlay is active), plus the always-routed Ctrl+C:

1. **Overlays** - when `approvalActive` / `questionActive` / `modelPickerActive` / `levelPickerActive` / `renameModeActive` / `abgOverlayActive`, dispatch to the matching `handle*Input`. These still use the Ink-style `{ input, key }` pair assembled by the KeyEvent adapter.
2. **Ctrl+C** - always enqueues `{ type: 'interrupt' }` so the "press twice to exit" contract holds even mid-focus-race.
3. **Fallthrough** - editing/chord/scroll/history keys no longer arrive here; they route through `bridgeTextareaKeyDown` while the textarea is focused. This sink is a no-op for non-Ctrl+C keys when no overlay is open.

Raw editing (printable input, backspace, arrow movement, word-move, the real cursor, Enter-submit, and IME composition) never reaches the bridge. It is native `TextareaRenderable` behavior.

### Resolved Chord Conflicts

Four chords have a documented app-action meaning that collides with the textarea's native editing defaults. The conflict is resolved by giving the app layer the bare chord and moving the input-layer equivalent onto a non-colliding chord, then excluding the bare chord from the managed textarea binding set (`EXCLUDED_TEXTAREA_CHORDS` in `keymap-managed-layer.ts`, applied via `filterTextareaBindings`). The `platform/keymap/chord-conflicts.test.ts` contract pins these exact values against future drift.

| Bare chord (app layer owns it) | App action | Input-layer equivalent (restored) |
|---|---|---|
| `ctrl+e` | `editor_open` (external editor) | `input_line_end` = `ctrl+shift+e` |
| `ctrl+z` | `terminal_suspend` (SIGTSTP) | `input_undo` = `ctrl+-`, `input_redo` = `ctrl+.` |
| `home` / `end` | transcript scroll-to-top / -bottom | `input_buffer_home` = `ctrl+shift+home`, `input_buffer_end` = `ctrl+shift+end` |
| `ctrl+p` | `model_cycle` (unchanged) | palette is `alt+x`, not `ctrl+p` |
| `ctrl+g` | `abg_overlay_toggle` | `messages_first` is `ctrl+shift+home`, not `ctrl+g` — no collision |

`messages_first` (`ctrl+shift+home`) and `input_buffer_home` (`ctrl+shift+home`) intentionally share a chord; layer priority resolves it (`input.*` at default priority wins while the textarea is focused; `messages.*` at priority `-100` wins while it is blurred). The default chords live in `keybind.ts` (`Definitions`) and are rebindable end-to-end via the T17 config loader (`keybinds.json`); `/hotkeys` is registry-driven (T17) and auto-reflects any rebind. `Ctrl+C` is the one exception: it is hardcoded, routes through the global `useKeyboard` sink, and is deliberately absent from the registry (see the Ctrl+C anti-pattern).

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

The markdown pipeline (`src/components/markdown/`) is opentui-native: `Markdown.tsx` walks `marked` tokens into a serializable IR (`InlineRun`/`RenderLine`/`RenderBlock`), styled by `theme.ts` (`darkTheme`), with code-block syntax highlighting from `highlight.ts` (T5) and streaming-unsafe markdown healing from `stream.ts` (T3). A 64-entry LRU cache (`getCachedBlocks`) keys on `(text, width, streaming, theme)`. Wrapping uses `wrap-ansi` with `trim:false` so every character survives; CJK double-width glyphs are counted as 2 columns by `string-width`/`get-east-asian-width`, so lines never overflow the target width.

`parseMessageBlocks` splits `outputText` WITHOUT dropping blank lines: interior blanks survive as markdown paragraph separators (so `Assistant: para1\n\npara2` stays one block), and only leading/trailing empties are trimmed. Continuation absorption keeps multi-line assistant/thinking messages as a single markdown unit (absorbing only `system`-classified lines), while tool blocks keep the broader `!isStrongBoundary` absorption. Tool-preview lines (`Edit preview for`, `+++`, `---`, etc.) are strong-enough boundaries that they always start a new `tool` block.

`MessageBlock` routes each `ChatBlock`: assistant/thinking → `MarkdownPanel` (a colored bar whose row count matches the rendered markdown line count, plus the `<Markdown>` tree); tool → `<ToolCard>`; user/error/system → the legacy flat row. The `toolOutputExpanded` flag (Ctrl+O toggle) collapses `<ToolCard>` to a header-only `> title (N lines)` view.

The transcript is a native opentui `<scrollbox>`. `MessageWindow` renders its blocks inside `<ChatTranscript>` (a `<scrollbox stickyScroll stickyStart="bottom" flexGrow={1}>` with a `MacOSScrollAccel`). There is no JS-side windowing budget: the `ScrollBoxRenderable` renders only the visible children and pins streaming output to the bottom via `stickyScroll`. Imperative scroll (Home/End/PgUp/PgDn from `bridgeTextareaKeyDown`) reaches the scrollbox through `scrollboxRef.current.scrollTo` / `scrollBy` / `scrollHeight`. The old `selectTrailingBlocks` / `getMessageWindowLineBudget` tail-slicing is gone.

Selectable text and copy-on-mouseup. Flat `<text>` blocks (system, user, error) are explicitly `selectable`; `Markdown` leaves default to selectable too, so assistant/thinking content is mouse-drag selectable. `ChatRoot`'s root `<box>` carries an `onMouseUp` handler: it checks `clipboardService.isOsc52Supported()`, and when supported calls `copy()` (selection-copy to `clipboardService.copyToClipboard`, which emits OSC52 from opentui's native Zig core). When OSC52 is unavailable and the user had a selection, it writes a stderr notice instead of silently no-op'ing. tmux needs `set -g set-allow-passthrough on`; iTerm2, Alacritty, Kitty, WezTerm, and Windows Terminal work directly.

The diff renderer (`src/components/diff/`) classifies mctrl's no-line-number format (`-old`/`+new`/`--- a/`/`+++ b/`/`@@`) via `render-diff.ts` and renders green/red/cyan rows with inverse intra-line highlighting through `DiffView.tsx`. `ToolCard` auto-detects diff content via `hasDiffContent` and routes accordingly; prose tool output falls back to plain yellow lines.

### Screen Layout (top to bottom)

```
┌─ Banner (dim text, no left bar) ───────────────┐
│  mission-control chat                            │
│  provider: zai-coding-plan                       │
│  Press Ctrl+C twice or /exit to exit             │
└──────────────────────────────────────────────────┘
┌─ <ChatTranscript> native <scrollbox> (stickyScroll, flexGrow) ┐
│ ┌─ User (cyan left bar) ───────────────────────┐             │
│ │  Hello, what is 2+2?                          │             │
│ └───────────────────────────────────────────────┘             │
│ ┌─ Assistant (green left bar) ─────────────────┐             │
│ │  2 + 2 = 4                                    │  selectable │
│ └───────────────────────────────────────────────┘  (mouse-up  │
│ ┌─ Error (red left bar) ───────────────────────┐   = OSC52)  │
│ │  Insufficient balance...                      │             │
│ └───────────────────────────────────────────────┘             │
│   ↑ Home/End/PgUp/PgDn scroll this box via scrollboxRef       │
└───────────────────────────────────────────────────────────────┘
  (slash / workflow / @-file menu - shown when input starts with /, #, @)

────────────────────────────────────────── ← separator line (dim ─)
┌─ <ChatInputTextarea> native <textarea> ─────────┐
│ Type a message or / for commands█               │  ← real native cursor
└──────────────────────────────────────────────────┘     (TextareaRenderable)

provider: X | model: Y | session: Z      ← status bar (dim)
```

The cursor is the textarea's real native cursor (drawn by `TextareaRenderable`), not a synthesized glyph. The transcript scrolls inside its own `<scrollbox>`; there is no whole-screen PgUp/PgDn scroll offset and no JS-side windowing budget.

### Slash Command Autocomplete

When the input buffer starts with `/`, a filtered command menu renders between the message blocks and the separator line. The menu uses the existing `createSlashCommandMenuView` from `interactive-chat-command-menu.ts`.

- Typing filters commands (e.g., `/ex` matches `/exit`)
- Arrow Up/Down navigates the selection
- Enter resolves the partial match via `resolveSlashCommandMenuSubmission()` before submitting
- The selected command is highlighted with `>` marker and blue background

### Model Picker Overlay

When `/model` is invoked, `showModelPicker(choices)` is called on the bridge. This switches `modelPickerActive` to true, causing ChatRoot to render a full-screen overlay replacing the normal output/menu/input/status layout.

The model picker reuses `ProviderPromptKeypress` state machine (the same one used by the terminal model selector and auth provider prompts). Arrow keys are converted from the adapter's boolean flags (`key.upArrow`) to escape sequences (`\u001b[A`) for the reducer.

### Error Handling

Provider errors (insufficient balance, rate limit, auth failure, network error) are caught at three layers:

1. **Fallback provider path** (`interactive-chat-prompt-turn.ts`): `result.status === 'failed'` writes `Error: <message>` to chatOutput instead of throwing
2. **Coding agent path** (`interactive-coding-agent.ts`): `settleReceipt` failed case writes to output instead of throwing; turn `done` promise has `.catch()`
3. **Main loop** (`interactive-chat.ts`): `try-catch` around `runChatAction` as safety net

JSON error responses from providers (e.g., `{"error":{"message":"..."}}`) are parsed in `openai-compatible-errors.ts` via `extractReadableErrorMessage()` to extract the human-readable message.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| opentui bridge (core state, input, render) | `src/commands/opentui-chat-bridge.tsx` | Heart of the interactive chat. `/** @jsxImportSource @opentui/react */` pragma on line 1. |
| opentui model selector adapter | `src/commands/opentui-model-selector.ts` | Maps bridge.showModelPicker to ModelSelector |
| opentui ChatInput adapter | `src/commands/opentui-chat-input.ts` | Delegates to bridge.waitForEvent |
| opentui ChatOutput adapter | `src/commands/opentui-chat-output.ts` | Delegates to bridge.emitOutput |
| opentui components | `src/components/*.tsx` | ChatInputTextarea (native `<textarea>` wrapper), ChatTranscript (native `<scrollbox>`), Markdown, DiffView, ToolCard, StatusBar, Separator. Each opentui-intrinsic file starts with the `@jsxImportSource @opentui/react` pragma. |
| Bridge input handlers + test seams | `src/commands/opentui-chat-bridge.tsx` | `bridgeTextareaKeyDown` / `bridgeSubmit` / `bridgeContentChange` (exported so tests can drive them against recording refs); `handleInput` is overlay-routing only. |
| Bridge test support | `src/commands/opentui-chat-bridge-test-support.ts` | `TextareaLike`, `createRecordingTextarea`, `createRecordingScrollbox`, `makeKeyEvent`, `asTextareaRef` / `asScrollboxRef`. |
| Clipboard copy | `src/platform/clipboard-service.ts`, `src/platform/selection-copy.ts` | OSC52 clipboard service plus mouseup selection-copy; `isOsc52Supported()` gates the stderr fallback. |
| opentui renderer mount/unmount | `src/platform/opentui-renderer.ts` | `mountOpenTui(element)` dynamic-imports `createCliRenderer` + `createRoot`, returns `{ renderer, root, unmount }`. |
| KeyEvent adapter | `src/platform/key-event-adapter.ts` | `createKeyEventAdapter` / `adaptKeyEvent`: opentui `KeyEvent` → Ink-compatible `{ input, key }`. Stateless, per-event. |
| opentui type mappings | `src/platform/opentui-types.ts` | `toOpenTuiColor`, `toOpenTuiBorderStyle`, `toOpenTuiAttributes` (Ink color/flag → opentui `fg`/`bg`/`attributes`). |
| Markdown renderer | `src/components/markdown/Markdown.tsx` | opentui-native markdown: token walker → IR (`InlineRun`/`RenderLine`/`RenderBlock`) → `<box>`/`<text>`. Pure helpers (`getCachedBlocks`, `reflowRuns`, `renderInlineToRuns`, `computeTableColumnWidths`) are exported for unit tests. 64-entry LRU cache. |
| Markdown theme | `src/components/markdown/theme.ts` | `darkTheme` (14 element styles + `highlightCode` slot), `noColorTheme`. `InkTextStyle` = subset of opentui `<text>` props. |
| Markdown streaming healer | `src/components/markdown/stream.ts` | `streamBlocks` heals incomplete markdown (open `**`, ```` ``` ```` fence) via `remend` and splits live input into renderable blocks. Never throws. |
| Code highlighting | `src/components/markdown/highlight.ts` | `highlightCode` is a thin re-export over `tree-sitter-highlighter.ts` (opentui tree-sitter backend with async cache-fill); scope→style table in `syntax-rules.ts`; 34-language grammar config in `parsers-config.ts`; zero raw ANSI leakage. |
| Diff renderer | `src/components/diff/` | `render-diff.ts` classifies mctrl no-line-number diffs; `DiffView.tsx` renders green/red/cyan with inverse intra-line spans. `kindStyle`/`splitLineSpans` exported for tests. |
| Tool card | `src/components/ToolCard.tsx` | Bordered card; `hasDiffContent` auto-routes to `<DiffView>` or yellow prose lines; `expanded` prop collapses to header. |
| Executable entry, help, version | `src/index.tsx` | Package `bin` maps `mctrl` to `./dist/index.js`. |
| Top-level flags and modes | `src/args.ts` | Keep command/mode string unions explicit. Default mode is `'tui'` (opentui); `--no-tui`/`--json`/`--jsonl` select the non-interactive renderers. |
| Run and graph args | `src/run-args.ts` | Owns `--json`, `--jsonl`, provider/model, native, graph, `--workspace`, `--session`, `--engine` flags. |
| Auth args | `src/auth-args.ts` | Delegates into `src/commands/auth*.ts`. |
| Session args | `src/session-args.ts` | Delegates into `src/commands/session.ts`. |
| Runtime orchestration | `src/commands/run-agent.ts` | Chooses chat/non-interactive paths, provider setup, permissions, renderers, workspace root resolution (`--workspace` > `MCTRL_WORKSPACE` > `detectWorkspaceRoot()`). |
| Interactive chat | `src/commands/interactive-chat*.ts` | Terminal input, slash commands, model picker, approval broker. Non-TTY fallback path. `useTui` gates the opentui bridge on `process.stdin.isTTY`. |
| Command parsing | `src/commands/chat-commands.ts` | parseChatLine → ChatLineAction |
| Slash command menu state | `src/commands/interactive-chat-command-menu.ts` | createSlashCommandMenuView, resolveSlashCommandMenuSubmission |
| Model discovery | `src/commands/model-discovery.ts` | Per-provider API calls for live model lists |
| Models command | `src/commands/models.ts` | `mctrl models` — runtime catalog + discovery union |
| Provider factory | `src/commands/provider-factory.ts` | Maps capability → adapter |
| Runtime catalog | `packages/config/src/models-dev-runtime.ts` | Fetches models.dev with 5min disk cache |
| Output modes | `src/ui/renderers.ts` | Plain, TUI (buffered summary), and JSON renderer contracts. |
| CLI package targets | `package.json`, `project.json` | `tsc` build, verbose Vitest, Nx `cli:*` targets. |
| Agent spinner | `src/commands/opentui-chat-bridge.tsx` (AgentSpinner) | Braille spinner (`⠋⠙⠹…`) at 80ms; shows "Thinking…" / "Running X…" via `ChatOutput.setAgentStatus`. |
| Approval overlay | `src/commands/opentui-chat-bridge.tsx` (handleApprovalInput) | Arrow-key Up/Down/Enter/Ctrl+C navigation; `ChatOutput.showApproval`/`hideApproval`. |
| ChatOutput extensions | `src/commands/interactive-chat-io.ts` | Optional `setAgentStatus`/`clearAgentStatus`/`showApproval`/`hideApproval` methods. |
| Workspace resolution | `src/commands/run-agent.ts` (`resolveWorkspaceRoot`, `detectWorkspaceRoot`) | `--workspace <path>` flag wins, then `MCTRL_WORKSPACE` env var, then `.git`/workspaces heuristic walking up from `process.cwd()`. |
| StatusBar render surface | `src/components/StatusBar.tsx` | Renders provider/model/variant/project/branch/session; `formatStatus` is exported for unit tests. |
| Session store fix | `src/commands/run-agent-session.ts` | `createsTransientSessionStore` includes the `'tui'` mode so the graph path (with tools) is always used. |
| Retryable tool errors | `packages/core/src/tools/read-tools-errors.ts` | Repo tool failures are `retryable: true` — the model can adjust and retry instead of the run dying. |

## Conventions

- Keep CLI behavior behind `apps/cli`; do not move command-line parsing or terminal rendering into `packages/core`.
- Treat help text, JSON, JSONL, and plain output as user-facing contracts. Update focused tests when strings, event ordering, or redaction changes.
- Normal prompts can run through the deterministic local provider or the OpenAI-compatible adapter when configured. `$skill <name>` and `/<skill-name>` load a discovered skill's `SKILL.md` body as the next user prompt (real skill loading, replacing the old scaffold recorder); the loaded body is inert text and does not call Codex host skills or spawn agents on its own. A real tool-calling provider is required for loaded skills to drive agentic behavior — the default `local/local-echo` provider does not call tools.
- Store auth through `auth-store.ts`; never print raw API keys, OAuth tokens, or multi-field credentials.
- Argument parsing stays parse-only. Runtime effects belong in command modules.
- Renderer code should consume protocol/core events, not private runtime fields.
- The markdown/diff/ToolCard renderers consume already-redacted `outputText` (provider/tool output is redacted upstream in `packages/core`). Never read raw provider or tool structured output in a renderer.
- `react-test-renderer` is intentionally not a dependency. Test renderer logic via the pure exported helpers (`getCachedBlocks`/`reflowRuns`/`kindStyle`/`hasDiffContent`) or opentui's headless render path. Never mount a full React tree in a unit test.
- Visible-width math (wrapping, table columns, bar row counts) counts East Asian Wide glyphs as 2 columns — `wrap-ansi` relies on `string-width`/`get-east-asian-width`, so CJK never overflows.
- The textarea is the source of truth for editable text; `core.inputBuffer` is a mirror kept in sync by `bridgeContentChange`. The bridge core owns non-editing state (overlays, menus, history, event queue), and React components are read-only views of the snapshot.
- `useSyncExternalStore` requires `getSnapshot()` to return a referentially stable object — `publishSnapshot()` always creates a new object.
- The KeyEvent adapter feeds the global `useKeyboard` overlay sink only. Editing keys are native `TextareaRenderable` behavior; chords, scroll, and history ride `bridgeTextareaKeyDown` (raw `KeyEvent` plus `preventDefault`).
- `exactOptionalPropertyTypes` is active — use conditional spreads for optional props (`...(cond ? { prop: val } : {})`), and when sourcing opentui props from `| undefined` helpers (`toOpenTuiColor`), assign to a local first and narrow before spreading.
- Every `.tsx` file using opentui lowercase intrinsics MUST start with `/** @jsxImportSource @opentui/react */`. Under that pragma, component return types are `React.ReactNode`, not `React.JSX.Element`.
- User input echoed to outputText uses `You: ` prefix so `parseMessageBlocks` can classify it.
- Error messages use `Error: ` prefix for the same reason.
- Slash commands that start with `/` are NOT echoed to outputText (they're system commands, not conversation).
- The `controlsPrompt` flag is set to `true` in `opentui-chat-input.ts` so the imperative loop calls `renderPrompt()` (no-op) instead of writing `> ` to outputText. The prompt is rendered by ChatRoot's input area.

## Tests

- Colocated `*.test.ts` files under `src` are the package test surface.
- For argument changes, update `args.test.ts`, `run-agent-*`, `auth-*`, or `session.test.ts` as appropriate.
- For renderer/output changes, update `src/ui/renderers.test.ts` and the affected command-mode tests.
- Integration tests (`run-agent-chat.test.ts`) inject scripted `ChatInput`/`ChatOutput` via options, bypassing the opentui bridge entirely.
- The bridge itself is tested via `interactive-chat-terminal-input.test.ts` (legacy terminal path), the `opentui-chat-bridge-*.test.ts` suites, and manual tmux QA.
- Model command tests (`run-agent-model-command.test.ts`) verify `/model` parsing and selection logic.
- When modifying the bridge, always run tmux QA: start CLI, type a prompt, verify response, test `/exit` and Ctrl+C.
- Run focused CLI tests with `NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run cli:test` or `pnpm exec vitest run apps/cli/src/<file>.test.ts`.

## Anti-Patterns

- Do NOT mutate bridge core state directly from React components. Editing routes through the textarea (native) and `bridgeTextareaKeyDown`; overlays route through `handleInput`.
- Do NOT use `process.stdin.setRawMode()` directly — opentui's `createCliRenderer` manages raw mode.
- Do NOT add companion packages (ink-text-input, ink-select-input) — the Ink dependency has been removed. All components are custom-built on opentui intrinsics.
- Do NOT import from `'ink'` — the dependency is gone. The KeyEvent adapter reproduces Ink's input semantics; the `InkKeyShape` type is the structural mirror, imported from `opentui-chat-bridge.tsx` or `platform/key-event-adapter.ts`.
- Do NOT call `console.log` in TUI mode — the renderer may patch the stream. Use `process.stderr.write()` for debugging.
- Do NOT remove the non-TUI terminal fallback path — tests depend on it via scripted input injection.
- Do NOT bypass `createAllowPermissionDecision` or approval plumbing for write-capable command paths.
- Do NOT add shell-string command execution in CLI code.
- Do NOT make demo-only provider/model metadata look like an implemented provider adapter.
- Do NOT edit `dist`; it is generated by `tsc`.
- Do NOT write opentui-intrinsic `.tsx` files without the `/** @jsxImportSource @opentui/react */` pragma — lowercase intrinsics will not resolve against React's DOM types.
- Do NOT re-add a hand-rolled cursor or composition buffer. The `TextareaRenderable` owns the cursor, selection, and IME composition; the bridge only mirrors `plainText` into `inputBuffer`.
- Do NOT add a Ctrl+C copy regime. Copy is mouse-release only via OSC52 (`onMouseUp` on the root box). Ctrl+C is reserved for interrupt/exit and routes through the global sink, never the textarea.
- Do NOT spawn clipboard binaries (`pbcopy` / `xclip` / `wl-copy`) for copy. OSC52 is emitted by opentui's native core; surface unsupported terminals via stderr instead.
