<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# plain-markdown

## Purpose

Framework-free plain-TTY markdown IR pipeline (blocks/inline/layout/types + ANSI render/theme). Parallel to the OpenTUI `components/markdown` path; safe for non-Solid consumers and tests that must not load `@opentui/solid`.

## Key Files

| File | Description |
|------|-------------|
| `ir-types.ts` | IR type definitions |
| `ir-inline.ts` | Inline run builders |
| `ir-blocks.ts` | Block builders |
| `ir-layout.ts` | Layout/reflow over IR |
| `ansi.ts` | ANSI escape helpers |
| `ansi-renderer.ts` | IR → ANSI string renderer |
| `theme.ts` | Plain/ANSI theme tokens |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory
- Keep this tree free of `solid-js` and `@opentui/*` imports.
- Prefer sharing conceptual IR shapes with `components/markdown` without creating a hard runtime cycle into Solid.
- Use for headless/plain output paths and pure unit tests.

### Testing Requirements
- Covered indirectly via markdown/ansi tests; add local tests if pure helpers grow public contracts.

### Common Patterns
- Pure functions in/out; no component lifecycle.

## Dependencies

### Internal
- Consumed conceptually alongside `src/markdown.ts` and `components/markdown/`

### External
- None required (ANSI string construction only)

<!-- MANUAL: -->
