# PRD: Rendering: full-fidelity markdown, diff, and message styling

| Field | Value |
| --- | --- |
| Status | draft |
| Scope | Markdown renderer (`apps/cli/src/components/markdown/`), diff renderer (`apps/cli/src/components/diff/`), message block renderers (`apps/cli/src/components/*`) |

## Background

mctrl's output rendering lagged the reference renderers across markdown, diff, and overall message styling. The user explicitly refused scope cuts: full parity is the target, not a subset. Reference renderers live under `temp/ref-repos/` and define the concrete behavior below.

## Goals

- Markdown rendering is streaming-safe, theme-aware, syntax-highlighted, and width-correct for CJK.
- Diff rendering classifies lines, highlights intra-line word changes, visualizes indentation, and applies per-language code highlighting.
- Message blocks render as framed cards with rounded borders, a typed header, and a markdown body that can collapse.

## Non-Goals

- Replacing the existing `parseMessageBlocks` classification contract.
- Removing the trailing-window budget.

## Requirements

### Markdown rendering

1. Walk markdown tokens into a serializable IR (`InlineRun` / `RenderLine` / `RenderBlock`) before rendering, so rendering is a pure function of the IR + theme + width.
2. Apply a per-element theme with at least: heading (per-level), paragraph, bold, italic, strikethrough, inline code, code block, blockquote, ordered/unordered list, link, image alt, hr, table. Themes map to a subset of Ink `<Text>` style props.
3. Code blocks are syntax-highlighted: tokenize via a highlighting backend, map scopes to a fixed color table, and never leak raw ANSI escape codes into the output.
4. Streaming-safe healing: while a block is still streaming, heal incomplete markdown (open `**`, open ```` ``` ```` fence, unclosed inline code) via a markdown-fixer so partial output never breaks the layout. Healed state is discarded once the block completes.
5. Wrap rendered text with `trim: false` so no character is dropped; CJK / East Asian Wide glyphs are counted as 2 columns by the width function so lines never overflow the target column budget.
6. A bounded LRU render cache (entry count documented in code) keys on `(text, width, streaming, theme)` and is invalidated when any of those inputs changes; repeated renders of the same block are O(1).

### Diff rendering

7. Classify each diff line by its leading prefix: `+` (added), `-` (removed), space (context), and recognize the canonical `+N|content` form as well as the legacy `+N content` form. Lines are parsed into `(prefix, lineNum, content)` triples.
8. Render added lines in green, removed lines in red, and context lines in a dim/cyan tone.
9. For paired `+` / `-` lines, compute a word-level diff and apply inverse-video highlighting on the changed spans only; leading whitespace is stripped from the inverse span so indentation changes are not highlighted as content changes.
10. Visualize leading indentation: tabs render as a centered `→` glyph and leading spaces render as `·`, both in dim intensity, so indentation structure is visible without consuming content width.
11. Detect the source language from the diff's file path (or explicit language hint) and apply the same code-highlighting pipeline used by the markdown renderer to each diff line's content.
12. SGR escape sequences used for dim/inverse are additive (`\x1b[2m` / `\x1b[22m`) and preserve any active fg/bg color so layered styling does not bleed.

### Message block / framing

13. Each non-trivial message (assistant, thinking, tool output, hook/extension messages) renders inside a rounded-outline border whose color is a muted border tone (per theme), not a hard rectangle.
14. The frame header is an optional leading icon followed by the message-type tag (e.g. `Assistant`, `Thinking`, the tool name, or a custom type), styled bold in a theme-defined label color.
15. A spacer sits between the header and the body so the header reads as a title bar.
16. The body is rendered through the markdown pipeline (above); when the message is collapsed, the body is truncated to the first N lines followed by a trailing `…` (N is a per-call option, not a global constant).
17. A custom-renderer hook is invoked first; if it returns nothing or throws, the default outlined-card renderer takes over. The fallback path is wrapped so a throwing custom renderer never crashes the TUI.
18. The frame, header color, and label color are all sourced from the active theme so a theme switch restyles every message kind in one pass.

## Acceptance Criteria

- A streaming assistant block (markdown with an open code fence mid-token) renders without layout breakage.
- A CJK-heavy paragraph wraps without overflowing the terminal width.
- A diff with paired `+` / `-` lines shows inverse-highlighted changed words and dim `→` / `·` indentation markers.
- An assistant message renders inside a rounded-outline frame with a bold typed header.
- A hook/extension message whose custom renderer throws still renders via the default outlined-card fallback.
- Switching themes restyles every message kind without a restart.
