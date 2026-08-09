<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# components

## Purpose

OpenTUI Solid JSX UI components: chat input/transcript, overlays, status/tool cards, ABG/mission/models panels, visual graph, and nested markdown/diff/dialog pipelines.

## Key Files

| File | Description |
|------|-------------|
| `ChatInputArea.tsx` | Input region wrapper |
| `ChatInputTextarea.tsx` | Native `<textarea>` (`TextareaRenderable`) — cursor/selection/IME |
| `ChatTranscript.tsx` | Native `<scrollbox>` — typed `transcriptParts` first, legacy fallback; sticky-bottom render window |
| `ChatBottomDock.tsx` | Bottom dock: input + menus + status |
| `chat-bottom-dock-policy.ts` | Dock visibility/policy helpers |
| `TranscriptPartRenderer.tsx` | Exhaustive `TranscriptPart` → row router |
| `TypedTranscriptRows.tsx` / `TypedBlockPanel.tsx` | Typed row/panel renderers + lifecycle expansion |
| `LegacyTranscriptRenderer.tsx` | `ChatBlock` fallback renderer |
| `transcript-part-presentation.ts` | Presentation helpers for parts |
| `OverlayPanels.tsx` | Approval/question/model/level/rename overlays |
| `OverlayFrame.tsx` / `overlay-key-input.ts` / `overlay-theme.ts` | Overlay chrome, keys, theme |
| `SlashMenuPanel.tsx` / `FileAutocompletePanel.tsx` / `HistoryPickerPanel.tsx` / `PromptListPanel.tsx` | Menus/pickers |
| `StatusBar.tsx` | provider/model/variant/project/branch/session (`formatStatus` testable) |
| `ToolCard.tsx` | Bordered tool card; auto `<DiffView>` vs prose |
| `Toast.tsx` | Transient notices (sanitized title/message) |
| `WelcomeScreen.tsx` | Empty-session welcome |
| `Separator.tsx` / `AppShell.tsx` / `spinner.ts` | Chrome primitives |
| `AbgOverlay.tsx` / `AbgOverlayGraphPane.tsx` / `AbgOverlayPanesA.tsx` / `AbgOverlayPanesB.tsx` / `AbgOverlayPanesBDisplay.tsx` / `AbgMinimap.tsx` | ABG monitoring UI |
| `abg-display-projection.ts` / `abg-scroll.ts` / `abg-status-theme.ts` | Display-only ABG projection + scroll/theme |
| `visual-graph.ts` / `visual-graph-*.ts` | Graph canvas layout/edges/rows (dagre) |
| `MissionPanelOverlay.tsx` / `mission-panel-rows.ts` / `mission-panel-tabs.tsx` | Mission/jobs/agents panel |
| `ModelsOverlay.tsx` / `model-context-pref-lines.ts` | Model assignment overlay |
| `chat-theme.ts` / `chat-test-support.ts` | Theme tokens + framework-free test doubles |
| `prompt-history-recall.ts` / `prompt-list-controls.ts` | Prompt history UI helpers |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `dialog/` | Dialog host + alert/confirm/prompt/select (see `dialog/AGENTS.md`) |
| `diff/` | Diff classify + DiffView (see `diff/AGENTS.md`) |
| `markdown/` | OpenTUI markdown IR + highlight (see `markdown/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Components are read-only views of `ChatStore` + provider hooks; no direct CLI imports.
- Textarea owns editable text; store `inputBuffer` is a mirror.
- Sanitize only terminal-bound strings; keep raw answers/topology unsanitized in state.
- Tool rows: lifecycle-aware expand/collapse in `TypedTranscriptRows`.
- East-Asian wide glyphs = 2 columns for wrap/table math.

### Testing Requirements
- Heavy colocated `*.test.tsx` including terminal-sanitization suites for Question/Toast/Abg/Legacy/TranscriptPart.
- Typed transcript: ChatTranscript, TranscriptPartRenderer*, TypedTranscriptRows.lifecycle, typed-transcript-selection.
- Use `chat-test-support.ts` recording doubles — no full TUI tree mounts in unit tests.

### Common Patterns
- Return type `JSX.Element`; Solid signals/memos/onMount/onCleanup.
- `useSolidStoreSelector` for store projections.
- Inline JSX for child components that own scroll/focus state.

## Dependencies

### Internal
- `../state` — store, transcript parts, sanitizer, actions types
- `../platform` — keymap hooks, clipboard, store selector
- `dialog/`, `diff/`, `markdown/`

### External
- `@opentui/solid`, `solid-js`, `@dagrejs/dagre`

<!-- MANUAL: -->
