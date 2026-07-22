# Mission Control TUI Transcript Design Contract

This document is the design-system contract for the private Solid/OpenTUI
surface in `apps/tui`. It extracts the shipped OpenCode-aligned terminal
grammar from `src/components/chat-theme.ts`, `ChatTranscript.tsx`, `ToolCard.tsx`,
the markdown renderer, and the status/overlay primitives. It does not introduce
a second palette: semantic transcript names below map to existing TUI constants.

## 1. Atmosphere & Identity

Mission Control is a calm, dense terminal command surface. The transcript is an
immutable-looking scrollback lane above a mutable prompt dock: user intent has a
warm left rail and dark panel, assistant work is quiet markdown, and operational
detail is legible without competing with the answer. The signature is restrained
terminal depth: tonal charcoal panels and single-cell left rails distinguish
roles rather than card shadows, gradients, or decorative motion. The primary
user is an operator following an agent turn, including an operator reading CJK
output in a narrow terminal while a stream, tool, or error is still active.

## 2. Color

### Existing Palette and Semantic Transcript Tokens

These are design-language aliases for existing exported constants. They are not
new CSS variables or a request to duplicate literal colors in components.

| Semantic role | Existing token | Value | Usage |
| --- | --- | --- | --- |
| Transcript canvas | `CHAT_BG` | `#0a0a0a` | Root terminal background and neutral depth floor. |
| Raised transcript panel | `CHAT_PANEL_BG` | `#141414` | User message fill. |
| Composer surface | `CHAT_ELEMENT_BG` | `#1e1e1e` | Native textarea fill. |
| User identity/accent rail | `CHAT_PRIMARY` | `#fab283` | User left border and prompt emphasis. |
| Secondary reference | `CHAT_SECONDARY` | `#5c9cf5` | Links and secondary badges. |
| Assistant markdown/body | `CHAT_TEXT` | `#eeeeee` | Assistant, tool body, and readable primary text. |
| Status/event/de-emphasis | `CHAT_TEXT_MUTED` | `#808080` | System rows, tool titles, completed detail, and metadata. |
| Reasoning/warning | `CHAT_WARNING` | `#e5c07b` | Reasoning header and caution semantics. |
| Error | `CHAT_ERROR` | `#e06c75` | Error rail and error body. |
| Success/diff addition | `CHAT_SUCCESS` / `CHAT_DIFF_ADDED` | `#7fd88f` | Completed affirmative state and additions. |
| Diff removal | `CHAT_DIFF_REMOVED` | `#e06c75` | Removed diff spans. |
| Composer placeholder | `CHAT_PLACEHOLDER` | `#606060` | Non-input composer guidance. |

The transcript also reuses the existing overlay/status vocabulary when a state
is interactive: `SELECTED_BG` for selection, `STATUS_LINE_BG` for dock status
rows, and `ACCENTS` / `APPROVAL_LEVEL_COLORS` for overlays and policy state.
Do not substitute generic ANSI color names or add a new transcript-specific hex
value when one of these existing roles applies.

### Color Rules

- Assistant content remains neutral; color identifies a semantic state, not an
  entire prose response.
- Error, success, reasoning, and diff states retain their existing token even
  when a typed transcript part supplies richer metadata.
- Low-color rendering must preserve meaning with existing bold, dim, inverse,
  strikethrough, labels, and glyphs rather than relying on hue alone.

## 3. Typography

The TUI uses the operator's terminal font, not browser font families or CSS font
sizes. Hierarchy comes from terminal-native text treatments and renderer choice.

| Role | Renderer/treatment | Contract |
| --- | --- | --- |
| User message | Selectable plain text in `UserMessagePanel` | Preserve literal user input after the legacy `You: ` prefix. |
| Assistant answer | Streaming-aware `Markdown` with `darkTheme` | Markdown owns paragraphs, code, tables, and syntax spans. |
| Reasoning | Markdown under a dim italic `Thinking` / `Thought` header | Keep reasoning visually secondary to the answer. |
| Inline tool/status | Muted one-line title with a two-cell icon column and trailing status glyph | Optimize for scanability and non-color lifecycle recognition. |
| Block tool/diff/code/command | Plain terminal rows, `DiffView`, or markdown/code pipeline | Preserve command and diff whitespace exactly. |
| Error | Selectable body text in the error semantic token | Keep the error readable and copyable. |
| Legacy fallback | `parseMessageBlocks(outputText)` | Retain byte-exact text behavior until a typed part is present. |

Text is never truncated by JavaScript code-unit length when it is rendered in a
width-bound panel. `terminalDisplayWidth`, `string-width`, and the markdown
pipeline must continue to account for East Asian Wide glyphs as two terminal
cells. Do not split a grapheme cluster or a CJK character to fit a visual row.

## 4. Spacing & Layout

Terminal spacing is measured in cells and rows. Existing constants are the
spacing scale for the transcript:

| Intent | Existing token/value | Usage |
| --- | --- | --- |
| Assistant inset | `CHAT_ASSISTANT_PAD_LEFT = 3` | Assistant/reasoning markdown left inset. |
| User vertical padding | `CHAT_USER_PAD_Y = 1` | User panel top and bottom breathing room. |
| User horizontal padding | `CHAT_USER_PAD_X = 2` | User panel text inset. |
| Consecutive user separation | `CHAT_USER_MARGIN_TOP = 1` | Space before every user panel after the first. |
| Inline tool icon lane | `CHAT_TOOL_ICON_WIDTH = 2` | Stable icon alignment for inline tool rows. |
| Transcript ownership | `stickyScroll: true`, `stickyStart: 'bottom'` | The native scrollbox owns scroll position and windowing. |

The transcript is the flex-growing upper region with `minHeight={0}`. The
bottom dock reserves status and input rows; it must not take transcript scroll
ownership. Components read live `useTerminalDimensions().width` / `.height` in
JSX and never cache a first-read viewport value, so shrink-then-grow resizes do
not leave blank terminal regions.

The existing dock width classes remain the layout vocabulary: narrow below 66
columns, compact from 66 through 79, normal from 80 through 119, wide from 120
through 149, and spacious at 150 or more. At 72 columns, a 36-glyph East Asian
Wide CJK line consumes the complete usable width before transcript insets; typed
renderers must reflow within their assigned content width rather than overflow,
clip, or horizontally scroll the primary transcript.

## 5. Components

### Transcript Scrollbox

- **Structure**: Native `<scrollbox>` containing ordered transcript rows.
- **States**: Empty, sticky-at-bottom, manually scrolled, streaming, replayed,
  resized.
- **Accessibility**: Non-focusable transcript; selectable text and mouse-release
  OSC52 copy remain available.
- **Layout**: Sole scroll owner for output. The composer and overlays never
  replace its scroll model.

### User Part

- **Structure**: Left accent border, `CHAT_PANEL_BG` fill, padded selectable
  plaintext.
- **States**: First message, subsequent message, submitted ordinary prompt.
- **Contract**: `submitLine` creates this semantic part for a non-slash user
  message while retaining the exact `You: <text>\n` legacy fallback.

### Assistant Markdown Part

- **Structure**: Three-cell left inset and streaming-aware `Markdown`.
- **States**: Streaming, complete, multi-paragraph, code/table content, CJK
  reflow.
- **Contract**: A stable part ID updates the existing visual row in place; it
  does not move the row or remount the transcript around every stream chunk.

### Reasoning Part

- **Structure**: Muted/italic markdown under `Thinking` while active and
  `Thought` when complete.
- **States**: Empty-hidden, streaming, complete, hidden by the thinking toggle.
- **Contract**: Reasoning is semantic transcript data, not assistant prose
  inferred from a line prefix when a typed part is available.

### Inline Tool Part

- **Structure**: Two-cell icon lane plus muted one-line title and trailing
  status glyph.
- **States**: Pending/running, completed, failed, denied, subagent-result,
  collapsed.
- **Contract**: Read/search/network/task/agent operations stay compact until a
  body is useful. A status glyph (`[~]`, `[+]`, `[!]`, `[x]`) follows the bare
  title without lifecycle words. A failed or denied result remains discoverable
  without changing its first-seen transcript order.

### Block Tool Part

- **Structure**: Flat icon/title row with a trailing status glyph and an optional
  expanded body.
- **States**: Expanded, collapsed, command output, code output, diff output,
  error result.
- **Contract**: Use the existing `ToolCard` grammar without a panel rail, fill,
  padding, or aggregate statistics. Expanded diff payloads route to `DiffView`;
  prose and command output retain line order.

### Diff, Code, and Command Parts

- **Structure**: Flat tool title and trailing status glyph followed by `DiffView`,
  Markdown/code, or plain command rows when expanded.
- **States**: Addition, removal, context, hunk/meta, running command, completed
  command, failed command.
- **Contract**: Diff additions use `CHAT_DIFF_ADDED`, removals use
  `CHAT_DIFF_REMOVED`, and context remains dim. Never reclassify code or command
  body based on visual text heuristics when a typed body kind exists.

### Subagent Result Part

- **Structure**: Flat tool title with trailing status glyph and optional result
  detail when expanded.
- **States**: Running, completed, cancelled, failed, background result.
- **Contract**: Agent identity and result state remain semantic metadata. The
  current legacy parser may show these as generic tools until the typed
  transcript renderer is implemented.

### Status/Event Part

- **Structure**: Dim, selectable system row.
- **States**: Informational event, progress status, completion notice, muted
  historical event.
- **Contract**: Status is not assistant markdown and must not receive a user or
  error rail.

### Error Part

- **Structure**: Error-colored left rail, panel fill, selectable error text.
- **States**: Provider/runtime error, interrupted stream, tool failure detail.
- **Contract**: Errors retain `Error: <text>` fallback parity for replay and
  legacy consumers.

### Legacy Fallback Part

- **Structure**: Existing `parseMessageBlocks(outputText)` result.
- **States**: Full legacy transcript, mixed typed/legacy transcript, replay or
  undo replacement.
- **Contract**: Typed emission appends the supplied fallback text byte-for-byte;
  unknown or historical output continues through the current parser unchanged.

## 6. Motion & Interaction

Terminal redraw disrupts selection, so static is the default. `MCTRL_SPINNER`
enables the existing animated spinner/separator mode; typed transcript updates
must not add decorative animation or independent timers. Streaming changes
content in the current stable-ID row, while the scrollbox preserves sticky
bottom behavior unless the operator has moved away. Tool expansion remains a
deliberate control (`Ctrl+O` / existing tool-output state), not a hover-only
effect. Keyboard input, history, undo, overlays, and noninteractive fallback
paths keep their current ownership and must not be redirected through transcript
rendering.

## 7. Depth & Surface

The depth strategy is tonal shift plus single-cell semantic rails:

- `CHAT_BG` is the canvas.
- `CHAT_PANEL_BG` lifts user information one tonal step.
- `CHAT_ELEMENT_BG` identifies the editable composer as a distinct native
  control.
- Left borders carry user/error identity; tool rows stay flat.
- Status rows use the existing navy `STATUS_LINE_BG` to separate persistent
  context from transcript history.

Do not add box shadows, gradients, rounded web cards, or a parallel terminal
palette. The terminal's cell grid, tonal steps, and left accents are the
material system.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- All transcript text remains selectable and copyable; color is never the sole
  carrier of error, completion, pending, or denied state. Tool rows pair their
  bare title with a trailing status glyph.
- CJK, mixed-width punctuation, emoji, and combining marks use terminal display
  width rather than JavaScript string length. The 72-column CJK streaming case
  must preserve content and row order through resize.
- Resizes are live OpenTUI dimensions, not `process.stdout` snapshots. The
  transcript retains scroll ownership with `flexGrow={1}` and `minHeight={0}`.
- Static mode is the motion-safe default. Animated mode may use only the
  established spinner/separator behavior and must not invalidate text selection.
- Typed transcript adoption must preserve legacy `outputText` byte parity so
  undo, replay, diff-viewer extraction, and noninteractive paths continue to
  consume the established string contract.

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
| --- | --- | --- | --- |
| Legacy fallback still uses line-prefix classification. | `chat.ts` | Required for replay, undo, and noninteractive compatibility during migration. | Keep as the fallback path after typed rendering lands; remove only with an explicit persisted-format migration. |
| Some existing component literals match design tokens without importing them. | Existing transcript-adjacent renderers | This contract documents the canonical semantic token, but this task does not refactor production styles. | Consolidate only in a separately scoped production styling change with visual QA. |
