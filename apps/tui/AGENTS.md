# TUI Agent Guide

## Overview

`apps/tui` is the private OpenTUI app consumed by `apps/cli` via lazy import. It owns the React/OpenTUI component tree, the keymap platform, the terminal viewport abstraction, the markdown/diff rendering pipelines, the clipboard service, and the `ChatStore` reactive state cluster. It MUST NOT import from `apps/cli` or `@mission-control/cli`, and MUST NOT own CLI command parsing, auth, sessions, providers, or runtime orchestration. Those concerns stay in `apps/cli` and `packages/core`.

The dependency direction is strictly CLI -> TUI. The CLI lazy-loads `@mission-control/tui/create-chat-tui` only when the interactive TUI is active (`useTui === true`); noninteractive `mc --no-tui`/`--json`/`--jsonl` runs never load this package.

CLI runtime side-effects (dashboard data loading, agent enable/disable, model override writes) reach components through the injected `ChatAppActions` callback interface, not through imports.

## Structure

```
src/
|-- index.ts                  # barrel: pure primitives (terminal-text, chat, markdown) + state cluster
|-- terminal-text.ts           # pure: terminalDisplayWidth, segmentTerminalText, truncate, padEnd
|-- chat.ts                   # pure: ChatBlock, parseMessageBlocks, classifyLine, QuestionOption
|-- markdown.ts               # pure: streamBlocks (streaming markdown healer, imports marked + remend)
|-- create-chat-tui.tsx       # TUI mount function: builds ChatStore, mounts ChatApp, returns ChatTuiHandle
|-- replay-overlay.tsx         # replay overlay mount (ABG overlay over a replay session)
|-- components/               # OpenTUI React components (all .tsx with @jsxImportSource pragma)
|   |-- ChatApp.tsx           # root component
|   |-- ChatInputArea.tsx     # input wrapper
|   |-- ChatInputTextarea.tsx  # native <textarea> wrapper (owns cursor/selection/IME)
|   |-- ChatTranscript.tsx      # native <scrollbox> wrapper (owns output scroll)
|   |-- OverlayPanels.tsx      # approval/question/model/level/rename overlays
|   |-- SlashMenuPanel.tsx   # slash command autocomplete
|   |-- StatusBar.tsx       # provider/model/variant/project/branch/session
|   |-- Banner.tsx, Separator.tsx, ToolCard.tsx, ...
|   |-- AbgOverlay.tsx        # ABG monitoring overlay (+Panes A/B/Minimap)
|   |-- MissionPanelOverlay.tsx  # mission panel overlay
|   |-- ModelsOverlay.tsx      # model assignment overlay
|   |-- markdown/             # markdown pipeline: Markdown.tsx, theme, highlight, ansi-renderer, ansi-theme, stream, tree-sitter-highlighter, parsers-config, syntax-rules, text-attributes, render-cache
|   `-- diff/               # diff pipeline: DiffView.tsx, render-diff.ts
|-- platform/                # OpenTUI platform layer
|   |-- opentui-renderer.ts  # mountOpenTui/unmount (dynamic-imports createCliRenderer + createRoot)
|   |-- terminal-viewport.ts, terminal-viewport-react.ts  # TerminalViewport normalization, useTerminalViewport()
|   |-- clipboard-service.ts, selection-copy.ts  # OSC52 clipboard, mouseup selection copy
|   `-- keymap/             # keybind, keymap-instance, managed-layer, command-palette, which-key, diff-viewer, messages-scroll, etc.
`-- state/                 # pure TUI state cluster (NO opentui/react runtime imports)
    |-- index.ts             # barrel re-exported via @mission-control/tui/state
    |-- chat-store.ts       # ChatStore reactive store (useSyncExternalStore contract)
    |-- chat-tui-types.ts  # ChatTuiHandle, ChatTuiRuntimeOptions
    |-- chat-app-actions.ts   # ChatAppActions callback interface (CLI-injected side-effects)
    |-- chat-selector-store.ts, chat-input-event.ts
    |-- approval-level.ts, models-overlay-state.ts
    |-- interactive-chat-*.ts  # input history, file autocomplete, command menu, model, terminal keys, cursor nav
    |-- abg-overlay-*.ts       # ABG overlay state, controller, prefs store
    `-- welcome-data-types.ts, mission-services-types.ts, ...
```

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| TUI mount factory | `src/create-chat-tui.tsx` | `createChatTui(options)` builds a `ChatStore`, dynamic-imports the renderer + keymap provider + `ChatApp`, mounts the tree, and returns the imperative `ChatTuiHandle` consumed by `interactive-chat.ts`. `createChatTuiHandle(store, unmountFn)` is the testable seam that constructs the handle without the native renderer. |
| Chat reactive store | `src/state/chat-store.ts` | `ChatStore` owns all chat UI state (output, input mirror, overlays, menus, history, event queue) behind a `useSyncExternalStore` contract. `createChatStore` factory; 16ms-coalesced `emitOutput`; overlay-mode state machine; `waitForEvent`/`enqueueEvent` event queue. |
| TUI handle types | `src/state/chat-tui-types.ts` | `ChatTuiHandle`, `ChatTuiRuntimeOptions` (carries optional `missionControlServices` and `actions` injected by the CLI). |
| CLI side-effect interface | `src/state/chat-app-actions.ts` | `ChatAppActions` callback interface (`loadDashboardAgentEntries`, `loadMissionPanelRows`, `toggleAgentDisabled`, `setAgentModelOverride`, `isValidModelPattern`). CLI provides implementations; components call them. |
| Chat block parsing | `src/chat.ts` (via `@mission-control/tui/chat`) | `parseMessageBlocks` splits `outputText` into `ChatBlock` records (user/assistant/thinking/error/tool/system). Pure, zero imports. |
| Chat test support | `src/components/chat-test-support.ts` | `TextareaLike`, `createRecordingTextarea`, `createRecordingScrollbox`, `makeKeyEvent`, `asTextareaRef` / `asScrollboxRef`. Imports `@opentui/core` + react. |
| Root component | `src/components/ChatApp.tsx` | `ChatApp` renders the full tree: banner, transcript, input area, overlays. Owns `AgentSpinner` (braille spinner at 80ms). Reads `ChatStore` snapshot via `useSyncExternalStore`. |
| Input textarea | `src/components/ChatInputTextarea.tsx` | Wraps native `<textarea>` (`TextareaRenderable`): owns editable text, cursor, selection, IME composition. |
| Output transcript | `src/components/ChatTranscript.tsx` | Wraps native `<scrollbox>` (`ScrollBoxRenderable`): owns output scroll and windowing via `stickyScroll`. |
| Overlay panels | `src/components/OverlayPanels.tsx` | Approval, question, model picker, level picker, rename overlays. Arrow-key navigation over `ChatStore`. |
| Status bar | `src/components/StatusBar.tsx` | Renders provider/model/variant/project/branch/session; `formatStatus` exported for unit tests. |
| Tool card | `src/components/ToolCard.tsx` | Bordered card; `hasDiffContent` auto-routes to `<DiffView>` or yellow prose lines; `expanded` prop collapses to header. |
| ABG overlay | `src/components/AbgOverlay.tsx` | ABG monitoring overlay with panes A/B and minimap. Consumes `AbgOverlayState` from `src/state/abg-overlay-state.ts`. |
| Markdown renderer | `src/components/markdown/Markdown.tsx` | opentui-native markdown: token walker to IR (`InlineRun`/`RenderLine`/`RenderBlock`) to `<box>`/`<text>`. Pure helpers (`getCachedBlocks`, `reflowRuns`, `renderInlineToRuns`, `computeTableColumnWidths`) exported for unit tests. 64-entry LRU cache. |
| Markdown theme | `src/components/markdown/theme.ts` | `darkTheme` (14 element styles + `highlightCode` slot), `noColorTheme`. `TerminalTextStyle` = subset of opentui `<text>` props. |
| Markdown streaming healer | `src/markdown.ts` (via `@mission-control/tui/markdown`) | `streamBlocks` heals incomplete markdown (open `**`, ```` ``` ```` fence) via `remend` and splits live input into renderable blocks. Never throws. |
| Code highlighting | `src/components/markdown/highlight.ts` | `highlightCode` is a thin re-export over `tree-sitter-highlighter.ts` (opentui tree-sitter backend with async cache-fill); scope to style table in `syntax-rules.ts`; 34-language grammar config in `parsers-config.ts`; zero raw ANSI leakage. |
| ANSI renderer | `src/components/markdown/ansi-renderer.ts` | `renderMarkdownAnsi` for plain-TTY rendering. Depends on IR helpers in `Markdown.tsx` (split deferred). |
| Diff renderer | `src/components/diff/` | `render-diff.ts` classifies mctrl no-line-number diffs; `DiffView.tsx` renders green/red/cyan with inverse intra-line spans. `kindStyle`/`splitLineSpans` exported for tests. |
| opentui renderer mount | `src/platform/opentui-renderer.ts` | `mountOpenTui(element)` dynamic-imports `createCliRenderer` + `createRoot`, returns `{ renderer, root, unmount }`. Dynamic imports keep both packages out of the eager module graph for non-TUI CLI runs. `unmount()` is idempotent. |
| Terminal viewport | `src/platform/terminal-viewport.ts`, `src/platform/terminal-viewport-react.ts` | Normalizes OpenTUI dimensions into `TerminalViewport { columns, rows }`; `useTerminalViewport()` is the interactive TUI layout source of truth. |
| Clipboard copy | `src/platform/clipboard-service.ts`, `src/platform/selection-copy.ts` | OSC52 clipboard service plus mouseup selection-copy; `isOsc52Supported()` gates the stderr fallback. |
| Keymap layers | `src/platform/keymap/` | OpenTUI keymap instance, managed textarea composition (`keymap-managed-layer.ts`), command palette, which-key, diff viewer, message scrolling, selection copy, paste markers, and kill-ring layers. Keybind registry in `keybind.ts`; chord conflicts pinned by `chord-conflicts.test.ts`. |
| Replay overlay | `src/replay-overlay.tsx` | `runReplayOverlay` mounts an ABG overlay over a replay session. Lazy-loaded by CLI's `session.ts` via `@mission-control/tui/replay-overlay`. |
| Terminal text utilities | `src/terminal-text.ts` (via `@mission-control/tui`) | `terminalDisplayWidth`, `segmentTerminalText`, `truncateTerminalText`, `padEndToDisplayWidth`, grapheme/offset helpers. Uses `Intl.Segmenter` with code-unit fallback. Zero imports. |

## opentui Chat Architecture

### Native core via node:ffi (Node 26.3+)

opentui ships a Zig native core (`libopentui.so` / `.dylib` / `.dll`) accessed through an FFI backend. opentui's `loadBackend()` tries `bun:ffi` under Bun and `node:ffi` under Node, falling back to an unsupported backend on failure. With Node 26.3+, the `node:ffi` module is available and `createNodeBackend` handles dlopen, callbacks, and pointer arithmetic natively. No third-party FFI library or pnpm patch is required. Run the CLI with `--experimental-ffi` so `node:ffi` loads.

### TUI Handle Pattern

The CLI's `runInteractiveChatSession()` loop drives an imperative `ChatInput`/`ChatOutput` contract. `createChatTui` bridges that contract to the reactive React tree: `waitForEvent()` returns a `Promise<ChatInputEvent>`, `emitOutput(text)` appends to the store, `showModelPicker(choices)` returns a selection, and `unmount()` tears down. The React tree reads `ChatStore` snapshots via `useSyncExternalStore`.

Two native opentui renderables own what the old hand-rolled code used to. `<ChatInputTextarea>` wraps the native `<textarea>` (`TextareaRenderable`): it owns the editable text, the cursor, the selection, and IME composition. `<ChatTranscript>` wraps the native `<scrollbox>` (`ScrollBoxRenderable`): it owns output scrolling and windowing. `ChatStore` owns only non-editing state: overlay modes, menus, history, the `inputBuffer` mirror, and the event queue.

### Keyboard Routing

opentui's `useKeyboard` delivers one `KeyEvent` per physical keypress. Editing keys (printable input, backspace, arrows, word-move, Enter-submit, IME) stay on `TextareaRenderable` and the managed textarea keymap layer. App chords, transcript scroll, history recall, autocomplete completion, and submit run from the textarea `onKeyDown` handler with raw `KeyEvent.preventDefault()` when handled. Overlays read keyboard input through their mounted handlers while focus is redirected away from the textarea. Ctrl+C is always routed through the global `useKeyboard` sink so interrupt/exit works during focus races.

Four chords have documented app-action meanings that collide with the textarea's native editing defaults. The conflict is resolved by giving the app layer the bare chord and moving the input-layer equivalent onto a non-colliding chord. `chord-conflicts.test.ts` pins these exact values.

### JSX: per-file `@jsxImportSource` pragma

opentui's lowercase intrinsics (`<text>`, `<box>`, `<span>`, ...) collide with React's inherited DOM/SVG intrinsics. Instead of a global `declare module 'react'` augmentation, every `.tsx` file that uses opentui intrinsics starts with a per-file pragma:

```tsx
/** @jsxImportSource @opentui/react */
```

opentui's `jsx-runtime.d.ts` re-exports `jsx`/`jsxs`/`Fragment` from `react/jsx-runtime` at runtime but loads opentui's own JSX namespace at type time. Under this pragma, `JSX.Element` is `React.ReactNode` (not `ReactElement`), so component return types must be annotated `: React.ReactNode`.

### Output Rendering

Output text is parsed into `ChatBlock` objects by `parseMessageBlocks()` (in `src/chat.ts`). Each block kind routes to a dedicated renderer: user (cyan bar), assistant (green bar, markdown), thinking (magenta bar, markdown), error (red bar), tool (`<ToolCard>`), system (dim text). The markdown pipeline walks `marked` tokens into a serializable IR styled by `theme.ts`, with code-block syntax highlighting from `highlight.ts` and streaming-unsafe markdown healing from `stream.ts`. A 64-entry LRU cache keys on `(text, width, streaming, theme)`.

### Clipboard

Flat `<text>` blocks are explicitly `selectable`; `Markdown` leaves default selectable too. `ChatApp`'s root `<box>` carries an `onMouseUp` handler: when OSC52 is supported it calls `copy()` (selection-copy via opentui's native Zig core). tmux needs `set -g set-allow-passthrough on`; iTerm2, Alacritty, Kitty, WezTerm, and Windows Terminal work directly.

## Conventions

- Do not import from `apps/cli`, `../cli`, `../../cli`, or `@mission-control/cli`. The dependency direction is CLI -> TUI, never the reverse.
- Keep TypeScript strict: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noPropertyAccessFromIndexSignature`. Use `import type` for type-only imports.
- Every `.tsx` file using opentui lowercase intrinsics MUST start with the `/** @jsxImportSource @opentui/react */` pragma. Under that pragma, component return types are `React.ReactNode`, not `React.JSX.Element`.
- The pure subpath layer (`src/terminal-text.ts`, `src/chat.ts`, `src/markdown.ts`) MUST NOT import `@opentui/*`, `react`, or any CLI/core runtime module. Verified by `src/import-graph.test.ts`.
- The state cluster (`src/state/`) is pure (no `@opentui/*` or `react` runtime imports). It is exported via `@mission-control/tui/state` and eagerly imported by the CLI so opentui stays out of the noninteractive module graph.
- The main barrel (`src/index.ts`) re-exports pure primitives + the state cluster. It does NOT re-export opentui components. Component/platform modules are accessed via dedicated subpath exports in `package.json` (e.g. `./chat-app`, `./opentui-renderer`, `./keybind`, `./markdown-theme`). This prevents circular dependencies between the barrel and the state modules.
- Impure mount-surface modules (`create-chat-tui.tsx`, `replay-overlay.tsx`, `keymap-provider`) MUST be behind dedicated subpath exports, not the main barrel. Adding them to the barrel triggers circular init races where state modules import pure primitives from the barrel.
- Visible-width math (wrapping, table columns, bar row counts) counts East Asian Wide glyphs as 2 columns. `wrap-ansi` relies on `string-width`/`get-east-asian-width`, so CJK never overflows.
- Interactive TUI layout must derive from `TerminalViewport { columns, rows }` via `useTerminalViewport()`. Direct `process.stdout.columns/rows` reads are forbidden in components and keymaps. Enforced by `platform/terminal-global-policy.test.ts`.
- The textarea is the source of truth for editable text; `ChatStore.inputBuffer` is a mirror kept in sync by the content-change handler. `ChatStore` owns non-editing state (overlays, menus, history, event queue), and React components are read-only views of the snapshot.
- `useSyncExternalStore` requires `getSnapshot()` to return a referentially stable object. `publishSnapshot()` always creates a new object.
- `exactOptionalPropertyTypes` is active. Use conditional spreads for optional props (`...(cond ? { prop: val } : {})`).
- `react-test-renderer` is intentionally not a dependency. Test renderer logic via pure exported helpers (`getCachedBlocks`/`reflowRuns`/`kindStyle`/`hasDiffContent`) or opentui's headless render path.

## Tests

- Colocated `*.test.ts`/`*.test.tsx` files under `src` are the package test surface.
- `src/import-graph.test.ts` scans the 3 pure source files and asserts no `@opentui/*`, `react`, `apps/cli`, `@mission-control/cli` imports. Keep it green when adding pure modules.
- `tests/tui-cli-boundary.test.ts` (root) scans all non-test source under `src/` and asserts no `apps/cli`/`../cli`/`@mission-control/cli` references.
- `platform/terminal-global-policy.test.ts` scans `src/` for direct `process.stdout.columns/rows` reads. No allowed files.
- Run focused TUI tests with `NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run tui:test` or `pnpm exec vitest run apps/tui/src/<file>.test.ts`.

## Anti-Patterns

- Do NOT import from `apps/cli`, `../cli`, `../../cli`, or `@mission-control/cli`. The boundary is enforced by contract tests.
- Do NOT add `@opentui/*` or `react` runtime imports to the pure subpath files (`terminal-text.ts`, `chat.ts`, `markdown.ts`) or the state cluster (`src/state/`). These stay opentui-free so the CLI's noninteractive path never loads them.
- Do NOT re-export impure modules (components, platform, mount surface) from the main barrel (`src/index.ts`). Use dedicated subpath exports to avoid circular init races.
- Do NOT mutate `ChatStore` state directly from React components. Editing routes through the textarea (native) and the textarea keydown handler; overlays route through their dedicated handlers.
- Do NOT add re-export shims for moved modules to satisfy old import paths. All importers were rewritten to `@mission-control/tui/*` subpaths.
- Do NOT own CLI command parsing, auth, sessions, providers, or runtime effects. This package is a UI surface, not a runtime owner. CLI side-effects arrive through the injected `ChatAppActions` callback interface.
- Do NOT write opentui-intrinsic `.tsx` files without the `/** @jsxImportSource @opentui/react */` pragma. Lowercase intrinsics will not resolve against React's DOM types.
- Do NOT re-add a hand-rolled cursor or composition buffer. The `TextareaRenderable` owns the cursor, selection, and IME composition; the chat store only mirrors `plainText` into `inputBuffer`.
- Do NOT add a Ctrl+C copy regime. Copy is mouse-release only via OSC52 (`onMouseUp` on the root box). Ctrl+C is reserved for interrupt/exit and routes through the global sink, never the textarea.
- Do NOT spawn clipboard binaries (`pbcopy` / `xclip` / `wl-copy`) for copy. OSC52 is emitted by opentui's native core.
