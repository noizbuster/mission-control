<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# app

## Purpose

App shell layout extracted from the root composer: normal flex layout (upper → dock → modals), fullscreen overlays, modal popup host, spinner, and App-level hooks (keyboard, keymap layers, submit, repaint, toast, selection copy, renderable handles).

## Key Files

| File | Description |
|------|-------------|
| `NormalLayout.tsx` | Root box + `onMouseUp` + upper → dock → modals |
| `UpperRegion.tsx` | Welcome \| transcript + spinner + Toast + AbgMinimap |
| `FullscreenOverlays.tsx` | abg / diff-viewer / models-overlay fullscreen modes |
| `ModalOverlays.tsx` | Seven `ModalPopup` modes |
| `ModalPopup.tsx` | Modal chrome/host |
| `AgentSpinner.tsx` | Agent activity spinner |
| `app-helpers.ts` | Pure helpers re-exported by App |
| `agent-retry-countdown.ts` | Retry countdown display helper |
| `use-global-keyboard.ts` | Global keyboard sink (Ctrl+C interrupt/exit) |
| `use-keymap-layers.ts` | Registers app keymap layers |
| `use-submit.ts` | Submit / prompt send wiring |
| `use-repaint-effects.ts` | Repaint-on-transition via `requestRender` only |
| `use-selection-mouseup.ts` | OSC52 selection copy on mouseup |
| `use-renderable-handles.ts` | Native renderable handle wiring |
| `use-transient-toast.ts` | Transient toast lifecycle |
| `app-topology.test.ts` | Multi-file topology pins (mount shape, 7 modals, flex order, no IIFE ChatTranscript) |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory
- Store-only `AppProps` — no split-shell, no SlashMenu/FileAutocomplete owned here (those are dock/components).
- Pass `<ChatTranscript>` as inline JSX — never IIFE (`app-topology.test.ts` enforces).
- Resize is OpenTUI SIGWINCH + `attachResizeFullPaint` after mount; do not reintroduce poll/`renderer.resize` ladders.
- Read dimensions reactively in JSX; never const-freeze width/height.

### Testing Requirements
- `app-topology.test.ts` is the structural contract suite.
- Hook/helper unit tests: `use-submit.test.ts`, `app-helpers.test.ts`, `agent-retry-countdown.test.ts`, `UpperRegion.transient-notice.test.tsx`.

### Common Patterns
- Hooks return accessors/handlers; layout components stay mostly declarative.
- Fullscreen branch vs normal flex siblings decided in `app.tsx` using these modules.

## Dependencies

### Internal
- `../components/*` — transcript, dock, overlays, welcome
- `../state` — ChatStore snapshots
- `../platform` — keymap, clipboard, dimensions helpers

### External
- `@opentui/solid`, `solid-js`

<!-- MANUAL: -->
