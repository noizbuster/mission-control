<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# src

## Purpose

TUI source root: pure primitives, mount surfaces, thin App composer, and subtrees for layout (`app/`), components, platform, state, and plain-markdown IR.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Barrel: pure primitives + state cluster only (no components/providers) |
| `create-chat-tui.tsx` | `createChatTui` / `createChatTuiHandle` — mount factory returning `ChatTuiHandle` |
| `create-chat-tui.test.ts` | Mount/handle contract tests |
| `replay-overlay.tsx` | `runReplayOverlay` — ABG overlay over replay session (CLI lazy import) |
| `app.tsx` | Thin root composer: hooks → fullscreen vs normal layout |
| `app.test.ts` | Public re-export smoke |
| `chat.ts` | Pure legacy `parseMessageBlocks` / `classifyLine` fallback |
| `markdown.ts` | Pure `streamBlocks` streaming markdown healer (`marked` + `remend`) |
| `terminal-text.ts` | Pure display-width / segment / truncate / pad helpers |
| `terminal-grapheme-fallback.ts` | Grapheme segmentation fallback when `Intl.Segmenter` unavailable |
| `import-graph.test.ts` | Asserts pure files stay free of OpenTUI/CLI imports |
| `no-react-deps.test.ts` | Guards against accidental React deps |
| `provider-port-guard.test.ts` | Provider port / boundary guards |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `app/` | App layout modules + hooks (see `app/AGENTS.md`) |
| `components/` | OpenTUI Solid components (see `components/AGENTS.md`) |
| `platform/` | Renderer, viewport, clipboard, keymap, providers (see `platform/AGENTS.md`) |
| `state/` | Framework-free ChatStore cluster (see `state/AGENTS.md`) |
| `plain-markdown/` | Plain-TTY markdown IR pipeline (see `plain-markdown/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Impure mounts (`create-chat-tui`, `replay-overlay`) stay on dedicated package subpaths, not `index.ts`.
- Pure files (`chat.ts`, `markdown.ts`, `terminal-text.ts`) must not import framework runtimes.
- `app.tsx` stays thin — layout lives under `app/`.
- `src/test-support/` is empty; package-level shim is `apps/tui/test-support/`.

### Testing Requirements
- Mount tests in `create-chat-tui.test.ts`; boundary tests at this level.
- Subdir tests own their domains.

### Common Patterns
- Dynamic `import()` for renderer + providers inside mount to keep non-TUI graph clean.
- `/** @jsxImportSource @opentui/solid */` when file-level pragma needed.

## Dependencies

### Internal
- All child subdirs; `@mission-control/core` tui-stores via providers
- Package exports consumed by `apps/cli`

### External
- `@opentui/*`, `solid-js`, `marked`, `remend`

<!-- MANUAL: -->
