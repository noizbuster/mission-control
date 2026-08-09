<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# platform

## Purpose

OpenTUI platform layer: renderer mount/unmount, terminal viewport normalize, OSC52 clipboard + selection copy, tree-sitter bootstrap, Solid external-store selector helper, plus `keymap/` and `providers/` subtrees.

## Key Files

| File | Description |
|------|-------------|
| `opentui-renderer.ts` | `mountOpenTui` / unmount; dynamic-imports createCliRenderer + Solid root/render; idempotent unmount; resize full-paint attach; arms LoopWatchdog + emergency restore |
| `loop-watchdog.ts` | Event-loop lag probe (omp-aligned); rising-edge stall log; unref'd timer |
| `emergency-terminal-restore.ts` | Crash-safe terminal mode restore; alt-screen gated DECRST 1049; global hook for CLI crash-guard |
| `opentui-renderer.test.ts` | Mount lifecycle tests |
| `terminal-viewport.ts` | Pure `TerminalViewport {columns,rows}` normalize helper |
| `clipboard-service.ts` | OSC52 clipboard service; `isOsc52Supported()` |
| `selection-copy.ts` | Mouseup selection → copy via native core |
| `use-solid-store-selector.ts` | Shared `useSolidStoreSelector(store, selector)` bridge |
| `tree-sitter-bootstrap.ts` | Grammar/WASM bootstrap for highlighter |
| `terminal-global-policy.test.ts` | Scans `src/` — forbids `process.stdout.columns/rows` in interactive code |
| `smoke-opentui.ts` | OpenTUI smoke helper |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `keymap/` | Keybind registry, layers, palette, which-key (see `keymap/AGENTS.md`) |
| `providers/` | `MissionControlTuiProviders` composition root (see `providers/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Dynamic-import OpenTUI/Solid in the renderer so non-TUI CLI stays clean.
- Layout dimensions: components use `useTerminalDimensions()`; this dir's pure viewport helper is for non-Solid normalize only.
- No shell clipboard binaries — OSC52 only.
- Do not hand-roll per-component store subscribe bridges; use `useSolidStoreSelector`.

### Testing Requirements
- Colocated tests for renderer, viewport, clipboard, selection-copy, store selector, tree-sitter bootstrap, terminal-global-policy.

### Common Patterns
- Platform modules exported via package subpaths (`./opentui-renderer`, `./keybind`, `./providers`, …).

## Dependencies

### Internal
- `keymap/`, `providers/`
- `../state` types for store contract
- `packages/core` tui-stores (via providers)

### External
- `@opentui/core`, `@opentui/solid`, `solid-js`, `web-tree-sitter`

<!-- MANUAL: -->
