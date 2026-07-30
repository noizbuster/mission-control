<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# dialog

## Purpose

Reusable dialog primitives for the TUI: host, content shell, and alert/confirm/prompt/select variants driven by the route/dialog/theme provider.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Barrel exports |
| `dialog.tsx` | Core dialog component |
| `dialog-host.tsx` | Host that mounts active dialog from provider state |
| `dialog-content.tsx` | Shared content chrome |
| `dialog-alert.tsx` | Alert (ack-only) |
| `dialog-confirm.tsx` | Confirm yes/no |
| `dialog-prompt.tsx` | Text prompt |
| `dialog-select.tsx` | Select-from-list |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory
- Dialogs open through route/dialog provider APIs — do not ad-hoc mount over the transcript.
- Keep focus trap / dismiss keys consistent with keymap layers.
- No CLI or runtime side effects inside dialog bodies; return results via callbacks/provider.

### Testing Requirements
- Prefer provider-level tests under `platform/providers/route-dialog-theme-context.test.tsx` plus component-level if added.
- Keep dialogs headless-testable via pure props.

### Common Patterns
- Solid JSX OpenTUI intrinsics; theme tokens from dialog/theme context.

## Dependencies

### Internal
- `../../platform/providers` — route/dialog/theme
- Sibling overlay patterns in `../`

### External
- `@opentui/solid`, `solid-js`

<!-- MANUAL: -->
