<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# markdown

## Purpose

OpenTUI-native markdown pipeline: `marked` tokens → serializable IR (`InlineRun`/`RenderLine`/`RenderBlock`) → `<box>`/`<text>`, with themes, tree-sitter highlighting, streaming heal, ANSI plain-TTY renderer, and 64-entry LRU render cache.

## Key Files

| File | Description |
|------|-------------|
| `Markdown.tsx` | Token walker + IR + Solid render; exports `getCachedBlocks`, `reflowRuns`, `renderInlineToRuns`, `computeTableColumnWidths` |
| `theme.ts` | `darkTheme` / `noColorTheme`; `TerminalTextStyle`; `highlightCode` slot |
| `interactive-theme.ts` | Interactive/session theme variant |
| `highlight.ts` | Thin re-export over tree-sitter highlighter |
| `tree-sitter-highlighter.ts` | opentui tree-sitter backend + async cache-fill |
| `parsers-config.ts` | ~34-language grammar config |
| `syntax-rules.ts` | Scope → style table |
| `shared-syntax-style.ts` | Shared syntax style helpers |
| `text-attributes.ts` | Text attribute mapping to opentui props |
| `render-cache.ts` | 64-entry LRU keyed on `(text, width, streaming, theme)` |
| `ansi-renderer.ts` | `renderMarkdownAnsi` for plain-TTY (uses IR helpers) |
| `ansi-theme.ts` | ANSI color theme |
| `stream.test.ts` | Streaming-related coverage (healer also in `src/markdown.ts`) |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory
- Prefer testing pure IR helpers over full mounts.
- Zero raw ANSI leakage from highlighter into OpenTUI path.
- Streaming unsafe markdown is healed via `remend` in `src/markdown.ts` (`streamBlocks`) before blocks hit this renderer.
- CJK/wide glyph width must stay correct in tables/reflow.

### Testing Requirements
- `Markdown.test.tsx`, `Markdown.text-style.test.tsx`, `markdown-wrapping.test.ts`
- `highlight.test.ts`, `tree-sitter-highlighter.test.ts`, `parsers-config.test.ts`, `syntax-rules.test.ts`
- `theme.test.ts`, `ansi-renderer.test.ts`, `ansi-theme.test.ts`, `text-attributes.test.ts`, `stream.test.ts`

### Common Patterns
- IR is serializable and theme-agnostic until render.
- `highlightCode` plugged through theme slot for test doubles.

## Dependencies

### Internal
- `src/markdown.ts` — streaming healer entry
- `../../platform/tree-sitter-bootstrap.ts` — grammar bootstrap
- Related plain IR in `src/plain-markdown/`

### External
- `marked`, `remend`, `web-tree-sitter`, `@opentui/solid`, `solid-js`, `wrap-ansi`

<!-- MANUAL: -->
