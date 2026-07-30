<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# diff

## Purpose

Terminal diff rendering for tool cards and the diff-viewer keymap layer: classify mctrl no-line-number diffs and render green/red/cyan with inverse intra-line spans.

## Key Files

| File | Description |
|------|-------------|
| `render-diff.ts` | Pure diff classification + span split (`kindStyle`, `splitLineSpans` exported for tests) |
| `render-diff.test.ts` | Classifier/span tests |
| `DiffView.tsx` | OpenTUI Solid diff view component |
| `DiffView.test.tsx` | Component tests |
| `diff-theme.ts` | Diff color/style tokens |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory
- Keep classification pure in `render-diff.ts` so non-Solid callers/tests work.
- `ToolCard` auto-routes to `DiffView` when `hasDiffContent` is true.
- Diff-viewer fullscreen keymap lives in `platform/keymap/diff-viewer.tsx`.

### Testing Requirements
- Unit-test pure helpers; component tests for rendering only.
- Do not require full App mount.

### Common Patterns
- Kind → style map; intra-line inverse spans for focused changes.

## Dependencies

### Internal
- Theme tokens local; `../ToolCard.tsx` consumer
- `platform/keymap/diff-viewer.tsx` fullscreen layer

### External
- `diff` (jsdiff), `@opentui/solid`, `solid-js`

<!-- MANUAL: -->
