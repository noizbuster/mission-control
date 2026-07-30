<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# keymap

## Purpose

OpenTUI keymap stack: keybind registry/config loader, keymap instance + Solid provider, managed textarea layer, command palette, which-key, diff viewer, messages scroll, kill-ring, leader addons, session shortcuts, model favorites, prompt history recall, slash mapping, bracketed paste, mode stack.

## Key Files

| File | Description |
|------|-------------|
| `keybind.ts` | Keybind registry |
| `keybind-config-loader.ts` | Load/merge user keybind config |
| `keymap-instance.ts` | Keymap instance construction |
| `keymap-provider.tsx` | Solid `KeymapProvider` / `useBindings` / `useKeymapSelector` |
| `keymap-managed-layer.ts` | Managed textarea composition layer |
| `keymap-chrome.tsx` | Keymap chrome UI bits |
| `command-palette.tsx` | Command palette overlay |
| `palette-open-context.ts` | Palette open context |
| `which-key-panel.tsx` / `which-key-panel-core.ts` | Which-key chord helper UI |
| `diff-viewer.tsx` | Diff viewer keymap/fullscreen layer |
| `messages-scroll.ts` | Transcript scroll chords |
| `kill-ring.ts` | Kill-ring editing behavior |
| `leader-addons.ts` / `leader-pending-cue.tsx` | Leader-key addons + pending cue |
| `session-shortcuts.ts` | Session navigation shortcuts |
| `model-favorites.ts` | Model favorite chords |
| `prompt-history-recall.ts` | History recall key bindings |
| `slash-mapping.ts` | Slash command key mapping helpers |
| `bracketed-paste.ts` | Bracketed paste handling |
| `mode-stack.ts` | Keymap mode stack |
| `message-undo-redo.ts` | Message undo/redo bindings |
| `chord-conflicts.test.ts` | Pins app-vs-textarea chord resolutions |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory
- Editing keys stay on `TextareaRenderable` + managed layer; app chords use layers with `preventDefault` when handled.
- Four documented app-action chords collide with textarea defaults — app layer wins bare chord; input moves to non-colliding chord (`chord-conflicts.test.ts`).
- Use `@opentui/keymap/solid` accessors; do not invent a custom selector bridge.
- Ctrl+C always via global sink, never textarea copy.

### Testing Requirements
- `chord-conflicts.test.ts`, `keybind.test.ts`, `keybind-config-loader.test.ts`, `command-palette.test.ts`, `kill-ring.test.ts`, `leader-addons.test.ts`, `messages-scroll.test.ts`, `model-favorites.test.ts`, `prompt-history-recall.test.ts`, `session-shortcuts.test.ts`, `which-key-panel.test.ts`, `keymap-input-rebind.test.ts`.

### Common Patterns
- Layer predicates read signals directly through existing signal-matcher helpers.
- Config loader merges user overrides without breaking required app chords.

## Dependencies

### Internal
- `../opentui-renderer.ts`, app hooks registering layers
- `../../components` panels opened by chords
- `../../state` for mode/overlay flags

### External
- `@opentui/keymap`, `@opentui/solid`, `solid-js`

<!-- MANUAL: -->
