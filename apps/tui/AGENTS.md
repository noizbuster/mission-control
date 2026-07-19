# TUI Agent Guide

## Overview

`apps/tui` is the private Solid/OpenTUI app consumed by `apps/cli` via lazy import. It owns the Solid JSX component tree (`@opentui/solid`), the keymap platform, the terminal viewport abstraction, the markdown/diff rendering pipelines, the clipboard service, typed transcript rendering, display-only projections, and the `ChatStore` state cluster. It MUST NOT import from `apps/cli` or `@mission-control/cli`, and MUST NOT own CLI command parsing, auth, sessions, providers, or runtime orchestration. Those concerns stay in `apps/cli` and `packages/core`.

The dependency direction is strictly CLI -> TUI. The CLI lazy-loads `@mission-control/tui/create-chat-tui` only when the interactive TUI is active (`useTui === true`); noninteractive `mc --no-tui`/`--json`/`--jsonl` runs never load this package.

CLI runtime side effects (dashboard data loading, agent enable/disable, model override writes) reach components through the injected `ChatAppActions` callback interface, not through imports.

## Structure

```text
src/
|-- index.ts                  # barrel: pure primitives (terminal-text, chat, markdown) + state cluster
|-- terminal-text.ts          # pure: terminalDisplayWidth, segmentTerminalText, truncate, padEnd
|-- chat.ts                   # pure: legacy ChatBlock fallback parser, classifyLine, QuestionOption
|-- markdown.ts               # pure: streamBlocks (streaming markdown healer, imports marked + remend)
|-- create-chat-tui.tsx       # TUI mount function: builds ChatStore, mounts App, returns ChatTuiHandle
|-- replay-overlay.tsx        # replay overlay mount (ABG overlay over a replay session)
|-- app.tsx                   # thin root composer: hooks + fullscreen vs normal branch
|-- app/                      # App layout modules + extracted hooks/helpers
|   |-- AgentSpinner.tsx, ModalPopup.tsx
|   |-- FullscreenOverlays.tsx  # abg / diff-viewer / models-overlay
|   |-- UpperRegion.tsx         # welcome | transcript + spinner + Toast + AbgMinimap
|   |-- ModalOverlays.tsx       # 7 ModalPopup modes
|   |-- NormalLayout.tsx        # root box + onMouseUp + upper → dock → modals
|   |-- app-helpers.ts          # pure helpers re-exported by App
|   `-- use-*.ts                # keyboard, keymap, submit, repaint, toast, handles
|-- components/               # OpenTUI Solid JSX components (all .tsx through @opentui/solid)
|   |-- ChatInputArea.tsx     # input wrapper
|   |-- ChatInputTextarea.tsx # native <textarea> wrapper (owns cursor/selection/IME)
|   |-- ChatTranscript.tsx    # native <scrollbox> wrapper (owns output scroll)
|   |-- TranscriptPartRenderer.tsx, TypedTranscriptRows.tsx, TypedBlockPanel.tsx  # typed transcript renderers
|   |-- OverlayPanels.tsx     # approval/question/model/level/rename overlays
|   |-- SlashMenuPanel.tsx    # slash command autocomplete
|   |-- StatusBar.tsx         # provider/model/variant/project/branch/session
|   |-- Banner.tsx, Separator.tsx, ToolCard.tsx, ...
|   |-- AbgOverlay.tsx        # ABG monitoring overlay (+Panes A/B/Minimap)
|   |-- abg-display-projection.ts  # display-only ABG and blackboard projections
|   |-- MissionPanelOverlay.tsx  # mission panel overlay
|   |-- ModelsOverlay.tsx     # model assignment overlay
|   |-- markdown/             # markdown pipeline: Markdown.tsx, theme, highlight, ansi-renderer, ansi-theme, stream, tree-sitter-highlighter, parsers-config, syntax-rules, text-attributes, render-cache
|   `-- diff/                 # diff pipeline: DiffView.tsx, render-diff.ts
|-- platform/                 # OpenTUI platform layer
|   |-- opentui-renderer.ts   # mountOpenTui/unmount (dynamic-imports createCliRenderer + Solid render/root)
|   |-- terminal-viewport.ts  # pure TerminalViewport {columns,rows} normalize helper
|   |-- clipboard-service.ts, selection-copy.ts  # OSC52 clipboard, mouseup selection copy
|   |-- providers/            # Solid provider root + provider hook services
|   `-- keymap/               # keybind, keymap-instance, keymap-provider, managed-layer, command-palette, which-key, diff-viewer, messages-scroll, etc.
`-- state/                    # pure TUI state cluster (NO framework or OpenTUI runtime imports)
    |-- index.ts              # barrel re-exported via @mission-control/tui/state
    |-- chat-store.ts         # ChatStore external store (subscribe/getSnapshot contract)
    |-- transcript-part.ts    # TUI-local TranscriptPart union and stable-ID upsert
    |-- terminal-display-sanitizer.ts  # display-only credential redaction and control escaping
    |-- chat-tui-types.ts     # ChatTuiHandle, ChatTuiRuntimeOptions
    |-- chat-app-actions.ts   # ChatAppActions callback interface (CLI-injected side effects)
    |-- chat-selector-store.ts, chat-input-event.ts
    |-- approval-level.ts, models-overlay-state.ts
    |-- interactive-chat-*.ts # input history, file autocomplete, command menu, model, terminal keys, cursor nav
    |-- abg-overlay-*.ts      # ABG overlay state, controller, prefs store
    `-- welcome-data-types.ts, mission-services-types.ts, ...
```

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| TUI mount factory | `src/create-chat-tui.tsx` | `createChatTui(options)` builds a `ChatStore`, dynamic-imports the renderer + keymap provider + `App`, mounts the Solid tree, and returns the imperative `ChatTuiHandle` consumed by `interactive-chat.ts`. `createChatTuiHandle(store, unmountFn)` is the testable seam that constructs the handle without the native renderer. |
| Chat state store | `src/state/chat-store.ts` | `ChatStore` owns chat UI state, including `transcriptParts` and legacy `outputText`, behind `subscribe()` + `getSnapshot()`. `emitTranscriptPart()` upserts a stable ID in first-seen order and retains fallback text for legacy consumers; `replaceTranscript()` restores both forms. It also keeps raw question text, headers, options, and answers separate from escaped display values. |
| Store selector hook | shared `useSolidStoreSelector` | Use `useSolidStoreSelector(store, selector)` from `platform/use-solid-store-selector.ts` to project a `subscribe`/`getSnapshot` store into a Solid accessor. Do not hand-roll `createSignal` + `onMount` + `subscribe` + `onCleanup` external-store bridges per component; use the shared helper. |
| TUI handle types | `src/state/chat-tui-types.ts` | `ChatTuiHandle`, `ChatTuiRuntimeOptions` (carries optional `missionControlServices` and `actions` injected by the CLI). |
| CLI side-effect interface | `src/state/chat-app-actions.ts` | `ChatAppActions` callback interface (`loadDashboardAgentEntries`, `loadMissionPanelRows`, `toggleAgentDisabled`, `setAgentModelOverride`, `isValidModelPattern`). CLI provides implementations; components call them. |
| Legacy chat block parsing | `src/chat.ts` (via `@mission-control/tui/chat`) | `parseMessageBlocks` splits legacy `outputText` into `ChatBlock` records (user/assistant/thinking/error/tool/system). Pure, zero imports. It is a fallback path, not the primary transcript model. |
| Chat test support | `src/components/chat-test-support.ts` | `TextareaLike`, `createRecordingTextarea`, `createRecordingScrollbox`, `makeKeyEvent`, and framework-free test helpers for native renderable seams. |
| Root component | `src/app.tsx` | Thin composer: wires hooks, then branches fullscreen (`FullscreenOverlays`) vs normal flex siblings (upper + dock + modals). Layout modules live under `src/app/` (`AgentSpinner`, `ModalPopup`, upper region, modal overlays). Reads `ChatStore` snapshots through Solid signals/accessors. |
| Input textarea | `src/components/ChatInputTextarea.tsx` | Wraps native `<textarea>` (`TextareaRenderable`): owns editable text, cursor, selection, IME composition. |
| Output transcript | `src/components/ChatTranscript.tsx` | Wraps native `<scrollbox>` (`ScrollBoxRenderable`) and renders `transcriptParts` first. It falls back to parsed `ChatBlock` rows only when no typed parts exist. |
| Typed transcript rendering | `src/state/transcript-part.ts`, `src/components/TranscriptPartRenderer.tsx`, `src/components/TypedTranscriptRows.tsx`, `src/components/TypedBlockPanel.tsx` | TUI-local `TranscriptPart` variants preserve semantic rows. `TranscriptPartRenderer` exhaustively routes them to typed rows; stable same-ID updates replace the mounted row, and lifecycle-aware rows keep active or multiline bodies expanded while settled one-line rows collapse. |
| Display sanitization | `src/state/terminal-display-sanitizer.ts`, `src/components/Toast.tsx`, `src/components/OverlayPanels.tsx` | Sanitize only terminal-bound text, with credential redaction and control escaping. Question overlays render escaped text and options but resolve raw answers; toasts sanitize title and message when rendered. |
| Overlay panels | `src/components/OverlayPanels.tsx` | Approval, question, model picker, level picker, rename overlays. Arrow-key navigation over `ChatStore`. |
| Status bar | `src/components/StatusBar.tsx` | Renders provider/model/variant/project/branch/session; `formatStatus` exported for unit tests. |
| Tool card | `src/components/ToolCard.tsx` | Bordered card; `hasDiffContent` auto-routes to `<DiffView>` or yellow prose lines; `expanded` prop collapses to header. |
| ABG overlay | `src/components/AbgOverlay.tsx`, `src/components/abg-display-projection.ts`, `src/components/AbgOverlayPanesBDisplay.tsx` | ABG monitoring overlay with panes A/B and minimap. Graph and pane data are projected only for display. Raw graph keys and edge endpoints must never be sanitized in storage; blackboard labels are sorted by raw key and receive deterministic collision suffixes after display sanitization. |
| Markdown renderer | `src/components/markdown/Markdown.tsx` | opentui-native markdown: token walker to IR (`InlineRun`/`RenderLine`/`RenderBlock`) to `<box>`/`<text>`. Pure helpers (`getCachedBlocks`, `reflowRuns`, `renderInlineToRuns`, `computeTableColumnWidths`) exported for unit tests. 64-entry LRU cache. |
| Markdown theme | `src/components/markdown/theme.ts` | `darkTheme` (14 element styles + `highlightCode` slot), `noColorTheme`. `TerminalTextStyle` = subset of opentui `<text>` props. |
| Markdown streaming healer | `src/markdown.ts` (via `@mission-control/tui/markdown`) | `streamBlocks` heals incomplete markdown (open `**`, ```` ``` ```` fence) via `remend` and splits live input into renderable blocks. Never throws. |
| Code highlighting | `src/components/markdown/highlight.ts` | `highlightCode` is a thin re-export over `tree-sitter-highlighter.ts` (opentui tree-sitter backend with async cache-fill); scope to style table in `syntax-rules.ts`; 34-language grammar config in `parsers-config.ts`; zero raw ANSI leakage. |
| ANSI renderer | `src/components/markdown/ansi-renderer.ts` | `renderMarkdownAnsi` for plain-TTY rendering. Depends on IR helpers in `Markdown.tsx` (split deferred). |
| Diff renderer | `src/components/diff/` | `render-diff.ts` classifies mctrl no-line-number diffs; `DiffView.tsx` renders green/red/cyan with inverse intra-line spans. `kindStyle`/`splitLineSpans` exported for tests. |
| opentui renderer mount | `src/platform/opentui-renderer.ts` | `mountOpenTui(element)` dynamic-imports the OpenTUI renderer and Solid root/render entrypoints, returns `{ renderer, root, unmount }`. Dynamic imports keep both packages out of the eager module graph for non-TUI CLI runs. `unmount()` is idempotent. |
| Provider root | `src/platform/providers/index.tsx` | `MissionControlTuiProviders` composes runtime, paths/config, runtime events, project/session replay, route/dialog/theme, local preferences, prompt history, prompt services, clipboard/toast, keymap, and plugin runtime providers. Exported only through `@mission-control/tui/providers`; the main barrel stays provider-free. |
| Terminal dimensions | `useTerminalDimensions()` from `@opentui/solid` | OpenCode pattern: read `dimensions().width` / `dimensions().height` in JSX. Pure `TerminalViewport` helper lives in `terminal-viewport.ts` for non-Solid normalize only. Resize is OpenTUI SIGWINCH; layout uses `flexGrow={1} minHeight={0}`. Do not wrap dimensions in createMemo/cache. |
| Keymap provider | `src/platform/keymap/keymap-provider.tsx` | Solid provider around `@opentui/keymap/solid`: `KeymapProvider`, `useBindings`, and `useKeymapSelector` return accessors. Layer predicates should read signals directly through the existing signal-matcher helper. |
| Clipboard copy | `src/platform/clipboard-service.ts`, `src/platform/selection-copy.ts` | OSC52 clipboard service plus mouseup selection-copy; `isOsc52Supported()` gates the stderr fallback. |
| Keymap layers | `src/platform/keymap/` | OpenTUI keymap instance, managed textarea composition (`keymap-managed-layer.ts`), command palette, which-key, diff viewer, message scrolling, selection copy, paste markers, and kill-ring layers. Keybind registry in `keybind.ts`; chord conflicts pinned by `chord-conflicts.test.ts`. |
| Replay overlay | `src/replay-overlay.tsx` | `runReplayOverlay` mounts an ABG overlay over a replay session. Lazy-loaded by CLI's `session.ts` via `@mission-control/tui/replay-overlay`. |
| Terminal text utilities | `src/terminal-text.ts` (via `@mission-control/tui`) | `terminalDisplayWidth`, `segmentTerminalText`, `truncateTerminalText`, `padEndToDisplayWidth`, grapheme/offset helpers. Uses `Intl.Segmenter` with code-unit fallback. Zero imports. |

## OpenTUI Solid Architecture

### Native Core Via node:ffi (Node 26.3+)

OpenTUI ships a Zig native core (`libopentui.so` / `.dylib` / `.dll`) accessed through an FFI backend. OpenTUI's `loadBackend()` tries `bun:ffi` under Bun and `node:ffi` under Node, falling back to an unsupported backend on failure. With Node 26.3+, the `node:ffi` module is available and `createNodeBackend` handles dlopen, callbacks, and pointer arithmetic natively. No third-party FFI library or pnpm patch is required. Run the CLI with `--experimental-ffi` so `node:ffi` loads.

### Build Configuration

The TUI package builds with Vite in library mode. `apps/tui/vite.config.ts` declares object entries that mirror `apps/tui/package.json` subpath exports.

`vite-plugin-solid` is configured with `solid: { moduleName: '@opentui/solid', generate: 'universal' }`. Its Babel module-resolver maps `solid-js` to `solid-js/dist/solid.js` and `solid-js/store` to `solid-js/store/dist/store.js` so Node execution lands on the published runtime files.

`apps/tui/tsconfig.json` uses:

```json
{
  "compilerOptions": {
    "jsx": "preserve",
    "jsxImportSource": "@opentui/solid"
  }
}
```

### TUI Handle Pattern

The CLI's `runInteractiveChatSession()` loop drives an imperative `ChatInput`/`ChatOutput` contract. `createChatTui` bridges that contract to the Solid tree: `waitForEvent()` returns a `Promise<ChatInputEvent>`, `emitOutput(text)` appends to the store, `showModelPicker(choices)` returns a selection, and `unmount()` tears down. Components read `ChatStore` snapshots through Solid accessors created from `store.subscribe()`.

Two native OpenTUI renderables own what the old hand-rolled code used to. `<ChatInputTextarea>` wraps the native `<textarea>` (`TextareaRenderable`): it owns the editable text, the cursor, the selection, and IME composition. `<ChatTranscript>` wraps the native `<scrollbox>` (`ScrollBoxRenderable`): it owns output scrolling and windowing. `ChatStore` owns only non-editing state: overlay modes, menus, history, the `inputBuffer` mirror, and the event queue.

### Provider architecture

The interactive mount dynamically imports `@mission-control/tui/providers`, then wraps `App` in `MissionControlTuiProviders`. The package exposes that provider composition root through the dedicated `./providers` package subpath and Vite library entry. Do not add provider exports to `src/index.ts`; the main barrel stays provider-free so pure utilities and the state cluster remain safe for eager CLI imports.

Provider-owned persistence lives in the TUI store classes from `packages/core/src/tui-stores/`, selected by `TuiPathsProviderValue` (`dataDir`, `configDir`, and workspace root). Components consume provider hooks and injected structural services; they do not instantiate `AgentRuntime`, provider adapters, tool registries, CLI action classes, or raw OpenCode SDK objects.

The plugin runtime provider is descriptor-first. Trusted manifests can register allowed slots, routes, commands, KV, dialog, and theme capabilities through `TuiPluginHostRegistry`; denied capabilities emit redacted diagnostics, project-local descriptors stay inert until workspace trust is granted, and provider cleanup disposes registrations. This is the plugin trust contract.

OpenCode references are reference material only. Mission Control ports selected patterns into strict protocol/core/TUI seams: OSC52 selection copy instead of shell clipboard binaries, prompt stash/frecency stores instead of ad-hoc component state, structural focused-editor access for kill-ring behavior, and descriptor-gated plugins instead of arbitrary project plugin execution.

Epilogue-style context surfaces are deferred; current context display remains the ABG/session replay projection providers. Editor parity is intentionally minimal: `Ctrl+E` launches `$VISUAL`/`$EDITOR`, and keymap layers operate on the focused OpenTUI textarea surface. There is no full embedded OpenCode editor subsystem.

### Solid JSX And Return Types

OpenTUI lowercase intrinsics (`<text>`, `<box>`, `<span>`, ...) resolve through `@opentui/solid`. The project-wide tsconfig sets `jsx: "preserve"` and `jsxImportSource: "@opentui/solid"`; files that need an explicit pragma use:

```tsx
/** @jsxImportSource @opentui/solid */
```

Component return types are `JSX.Element`. Type-only imports should use `import type`, and Solid helpers (`Accessor`, `JSX`) should be imported from `solid-js` only when needed.

### Signals, Effects, And Refs

Use Solid primitives for component state and lifecycle: `createSignal`, `createMemo`, `onMount`, `onCleanup`, and accessors. Store selectors should use the shared `useSolidStoreSelector(store, selector)` from `platform/use-solid-store-selector.ts` rather than hand-rolling `createSignal` + `onMount` + `subscribe` + `onCleanup` per component.

Use Solid callback refs, local variables, or signals for native renderable handles. Do not introduce object ref wrappers for components; narrow locals before use and keep renderable ownership at the component seam.

### Keyboard Routing

OpenTUI's `useKeyboard` delivers one `KeyEvent` per physical keypress. Editing keys (printable input, backspace, arrows, word-move, Enter-submit, IME) stay on `TextareaRenderable` and the managed textarea keymap layer. App chords, transcript scroll, prompt history list-select (Up at buffer start opens the 2-column history picker; Enter inserts fill-only; Esc closes), autocomplete completion, and submit run from the textarea `onKeyDown` handler with raw `KeyEvent.preventDefault()` when handled. Overlays read keyboard input through their mounted handlers while focus is redirected away from the textarea. Ctrl+C is always routed through the global keyboard sink so interrupt/exit works during focus races.

Use `@opentui/keymap/solid` for component-facing bindings. `KeymapProvider` supplies the keymap, `useBindings` registers Solid lifecycle-bound layers, and `useKeymapSelector` returns an `Accessor`. Do not add a custom selector bridge; compose keymap state with Solid accessors and existing pure helpers.

Four chords have documented app-action meanings that collide with the textarea's native editing defaults. The conflict is resolved by giving the app layer the bare chord and moving the input-layer equivalent onto a non-colliding chord. `chord-conflicts.test.ts` pins these exact values.

### Output Rendering

`ChatStore` renders typed `TranscriptPart` rows first. `TranscriptPartRenderer` dispatches the TUI-local union to `TypedTranscriptRows` and `TypedBlockPanel`; same-ID updates replace the existing row without changing its position. With expansion enabled, active one-line tool rows remain compact, active multiline tool rows can expand, active subagent rows remain collapsed, and settled one-line or multiline tool/subagent rows expose their bodies. `ChatBlock` parsing through `parseMessageBlocks()` remains the fallback when no typed rows exist, and `legacy` typed parts use that renderer for compatibility.

Canonical raw execution, history, permission, answer, identity, and topology values remain unsanitized. Only terminal-bound transcript, question, toast, and ABG display projections are credential-redacted then control-escaped; `ChatStore` may hold public display copies beside private raw question state. The sanitizer retains line feeds and normal Unicode, including CJK text. Toast titles and messages are sanitized when mounted. ABG graph rows, minimaps, panes, and blackboard values are projected for display only. Raw graph keys and edge endpoints must never be sanitized in storage; blackboard display labels are collision-safe through deterministic suffixes after sanitization.

Typed assistant, reasoning, and legacy text still use the markdown pipeline, which walks `marked` tokens into a serializable IR styled by `theme.ts`, with code-block syntax highlighting from `highlight.ts` and streaming-unsafe markdown healing from `stream.ts`. A 64-entry LRU cache keys on `(text, width, streaming, theme)`.

### Clipboard

Flat `<text>` blocks are explicitly `selectable`; `Markdown` leaves default selectable too. `App`'s root `<box>` carries an `onMouseUp` handler: when OSC52 is supported it calls `copy()` (selection-copy via OpenTUI's native Zig core). tmux needs `set -g set-allow-passthrough on`; iTerm2, Alacritty, Kitty, WezTerm, and Windows Terminal work directly.

## Conventions

- Do not import from `apps/cli`, `../cli`, `../../cli`, or `@mission-control/cli`. The dependency direction is CLI -> TUI, never the reverse.
- Keep TypeScript strict: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noPropertyAccessFromIndexSignature`. Use `import type` for type-only imports.
- OpenTUI `.tsx` files use Solid JSX through `@opentui/solid`; component return types are `JSX.Element`.
- The pure subpath layer (`src/terminal-text.ts`, `src/chat.ts`, `src/markdown.ts`) MUST NOT import `@opentui/*`, `solid-js`, framework runtimes, or any CLI/core runtime module. Verified by `src/import-graph.test.ts` for the current pure surface.
- The state cluster (`src/state/`) is framework-free (no `@opentui/*` or `solid-js` runtime imports). It is exported via `@mission-control/tui/state` and eagerly imported by the CLI so OpenTUI stays out of the noninteractive module graph.
- The main barrel (`src/index.ts`) re-exports pure primitives + the state cluster. It does NOT re-export OpenTUI components. Component/platform modules are accessed via dedicated subpath exports in `package.json` (e.g. `./app`, `./opentui-renderer`, `./keybind`, `./markdown-theme`). This prevents circular dependencies between the barrel and the state modules.
- Provider modules are accessed via `@mission-control/tui/providers`. Keep provider hook modules under `src/platform/providers/`; do not move provider runtime imports into `src/state/` or `src/index.ts`.
- Impure mount-surface modules (`create-chat-tui.tsx`, `replay-overlay.tsx`, `keymap-provider`) MUST be behind dedicated subpath exports, not the main barrel. Adding them to the barrel triggers circular init races where state modules import pure primitives from the barrel.
- Visible-width math (wrapping, table columns, bar row counts) counts East Asian Wide glyphs as 2 columns. `wrap-ansi` relies on `string-width`/`get-east-asian-width`, so CJK never overflows.
- Interactive TUI layout must use `useTerminalDimensions()` from `@opentui/solid` and read `.width`/`.height` in JSX (OpenCode). Direct `process.stdout.columns/rows` reads are forbidden in components and keymaps. Enforced by `platform/terminal-global-policy.test.ts`.
- Solid components run once. **Never** freeze reactive values:
  - ❌ `const w = dimensions().width` / `const cols = viewport().columns` then use `w`/`cols` in JSX
  - ❌ `function Foo({ viewportColumns })` for size props
  - ✅ `width={dimensions().width}` / `width={viewport().columns}` / `function Foo(props) { ... props.viewportColumns }` (OpenCode style)
  Destructuring or first-read const freezes values after mount and leaves blank expanded regions after shrink-then-grow.
- The textarea is the source of truth for editable text; `ChatStore.inputBuffer` is a mirror kept in sync by the content-change handler. `ChatStore` owns non-editing state (overlays, menus, history, event queue), and components are read-only views of the snapshot.
- Store selectors should expose Solid accessors whose values are updated from `store.subscribe()`. Keep `getSnapshot()` referentially stable between publishes and let `publishSnapshot()` create the next object.
- `exactOptionalPropertyTypes` is active. Use conditional spreads for optional props (`...(cond ? { prop: val } : {})`).
- Do not use legacy component test-renderer packages. Test renderer logic via pure exported helpers (`getCachedBlocks`/`reflowRuns`/`kindStyle`/`hasDiffContent`) or OpenTUI/Solid headless render paths.

## Tests

- Colocated `*.test.ts`/`*.test.tsx` files under `src` are the package test surface.
- `src/app/app-topology.test.ts` is the multi-file App topology suite: source-union + import-graph pins for mount shape (`createComponent(App, { store })`), store-only `AppProps`, no `ChatAppSplitShell`, no SlashMenu/FileAutocomplete in app modules, 7 ModalPopup modes, fullscreen abg/diff/models, OpenCode flex upper→dock→modals + `onMouseUp`, keymap layers, Ctrl+C global sink, repaint-on-transition via `requestRender` only, and provider hooks. `app.test.ts` keeps only the public re-export smoke. Terminal resize is OpenTUI SIGWINCH + `attachResizeFullPaint` after Solid mount (`platform/opentui-renderer.ts`); do not reintroduce poll/`renderer.resize`/hardReset ladders.
- `src/import-graph.test.ts` scans the 3 pure source files and asserts no `@opentui/*`, framework-runtime, `apps/cli`, or `@mission-control/cli` imports. Keep it green when adding pure modules.
- `tests/tui-cli-boundary.test.ts` (root) scans all non-test source under `src/` and asserts no `apps/cli`/`../cli`/`@mission-control/cli` references.
- `platform/terminal-global-policy.test.ts` scans `src/` for direct `process.stdout.columns/rows` reads. No allowed files.
- Typed transcript coverage lives in `state/chat-store.test.ts`, `state/transcript-fallback.test.ts`, `components/ChatTranscript.test.tsx`, `components/TranscriptPartRenderer*.test.tsx`, `components/TypedTranscriptRows.lifecycle.test.tsx`, and `components/typed-transcript-selection.test.tsx`. It covers typed-first selection, legacy fallback, stable same-ID updates, renderer reactivity, lifecycle-aware expansion, and selection retention.
- Display sanitization coverage lives in `components/QuestionOverlay.terminal-sanitization.test.tsx`, `components/Toast.terminal-sanitization.test.tsx`, `components/AbgOverlay.terminal-sanitization.test.tsx`, `components/AbgMinimap.terminal-sanitization.test.tsx`, and `components/abg-display-projection.test.ts`. It covers display-only escaping, raw question answers, raw graph topology, and deterministic blackboard-label collisions.
- Prefer Solid headless/pure-helper tests for components. Keep state cluster tests framework-free.
- Run focused TUI tests with `NX_DAEMON=false NX_ISOLATE_PLUGINS=false pnpm exec nx run tui:test` or `pnpm exec vitest run apps/tui/src/<file>.test.ts`.

## Anti-Patterns

- Do NOT import from `apps/cli`, `../cli`, `../../cli`, or `@mission-control/cli`. The boundary is enforced by contract tests.
- Do NOT add `@opentui/*`, `solid-js`, or other framework runtime imports to the pure subpath files (`terminal-text.ts`, `chat.ts`, `markdown.ts`) or the state cluster (`src/state/`). These stay OpenTUI-free so the CLI's noninteractive path never loads them.
- Do NOT re-export impure modules (components, platform, mount surface) from the main barrel (`src/index.ts`). Use dedicated subpath exports to avoid circular init races.
- Do NOT mutate `ChatStore` state directly from components. Editing routes through the textarea (native) and the textarea keydown handler; overlays route through their dedicated handlers.
- Do NOT add re-export shims for moved modules to satisfy old import paths. All importers were rewritten to `@mission-control/tui/*` subpaths.
- Do NOT own CLI command parsing, auth, sessions, providers, or runtime effects. This package is a UI surface, not a runtime owner. CLI side effects arrive through the injected `ChatAppActions` callback interface.
- Do NOT write OpenTUI-intrinsic `.tsx` files without the `/** @jsxImportSource @opentui/solid */` pragma when a file-level pragma is needed. Lowercase intrinsics must resolve against `@opentui/solid`.
- Do NOT re-add a hand-rolled cursor or composition buffer. The `TextareaRenderable` owns the cursor, selection, and IME composition; the chat store only mirrors `plainText` into `inputBuffer`.
- Do NOT add a Ctrl+C copy regime. Copy is mouse-release only via OSC52 (`onMouseUp` on the root box). Ctrl+C is reserved for interrupt/exit and routes through the global sink, never the textarea.
- Do NOT spawn clipboard binaries (`pbcopy` / `xclip` / `wl-copy`) for copy. OSC52 is emitted by OpenTUI's native core.
