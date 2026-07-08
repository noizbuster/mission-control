# Mission Control CLI — TUI Design Contract

> Authoritative design contract for the `apps/cli` terminal UI. Covers the ABG
> monitoring overlay, the dagre-driven graph canvas, the minimap, and the chat
> bottom-dock primitive.
>
> **Status legend:** each token is tagged `[EXISTING]` (already shipped in the
> named source file — document, do not invent) or `[NEW]` (grammar introduced
> by the graph/minimap work in T2/T3, not yet rendered).

Rendering stack is **terminal-cell-based**, not web. All output is ANSI escape
codes drawn through opentui (`@opentui/react` over a node:ffi native core on
Node 26.3+). `dagre` is used **only** for deterministic coordinate calculation
(x/y positions); every glyph and color is drawn by existing opentui intrinsics.

TypeScript is strict (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `verbatimModuleSyntax`,
`noPropertyAccessFromIndexSignature`). Biome owns lint/format.

## 1. Overlay Design Tokens

These tokens are `[EXISTING]` in `src/components/overlay-theme.ts`. Document
them verbatim; do not redefine.

| Token | Value | Source | Role |
| --- | --- | --- | --- |
| `SELECTED_BG` | `#0000ff` | `overlay-theme.ts:9` | Selection background for overlays/menus (supersedes per-file `#0000ff` copies). |
| `STATUS_LINE_BG` | `#0a1020` | `overlay-theme.ts:16` | Dark-navy (non-gray) background for the two status lines bracketing the chat prompt. |
| `ACCENTS.default` | `#00ffff` | `overlay-theme.ts:43` | Cyan fallback header foreground. |
| `ACCENTS.approval` | `#ffff00` | `overlay-theme.ts:44` | Yellow approval header. |
| `ACCENTS.question` | `#ff00ff` | `overlay-theme.ts:45` | Magenta question header. |
| `ACCENTS.error` | `#ff0000` | `overlay-theme.ts:46` | Red error header. |
| `APPROVAL_LEVEL_COLORS.verbose` | `#888888` | `overlay-theme.ts:24` | Gray (no saturation) ramp floor. |
| `APPROVAL_LEVEL_COLORS.safe` | `#26d926` | `overlay-theme.ts:25` | Green. |
| `APPROVAL_LEVEL_COLORS.aggressive` | `#d9d926` | `overlay-theme.ts:26` | Yellow. |
| `APPROVAL_LEVEL_COLORS.reckless` | `#d98526` | `overlay-theme.ts:27` | Orange. |
| `APPROVAL_LEVEL_COLORS.yolo` | `#d92626` | `overlay-theme.ts:28` | Red ramp ceiling. |

`OverlayVariant` (`overlay-theme.ts:36`) is `'modal' | 'panel' | 'view'`.
`OverlayChrome` flags (`overlay-theme.ts:52-62`): `modal` = inverse + bold;
`panel`/`view` = non-inverse + bold; `separator` is `false` for all three.
`headerAttrs` is `TextAttributes.BOLD` for every variant
(`overlay-theme.ts:94`). The inverse swap on the modal is realised by explicit
`fg`/`bg` in `<OverlayFrame>`, not SGR INVERSE.

Graph/minimap rendering reuses `ACCENTS` and `SELECTED_BG`; it does **not**
introduce new accent hex values. Palette extension happens in section 5. The
chat bottom dock also reuses `SELECTED_BG`, `STATUS_LINE_BG`, `ACCENTS`,
`APPROVAL_LEVEL_COLORS`, and `OverlayFrame` chrome; it does not introduce new
colors, fonts, spacing tokens, or visual style.

## 2. Graph Dimensions

The current graph pane (`GraphPane`, `src/components/AbgOverlayPanesA.tsx`)
renders a **1-D layered topological list** via `renderVisualGraph`
(`src/components/visual-graph.ts`). T2/T3 add a **2-D dagre-laid canvas**
rendered alongside it. Dimensions below are `[NEW]` unless tagged otherwise.

| Dimension | Value | Notes |
| --- | --- | --- |
| Layered max nodes | `16` | `[EXISTING]` `VISUAL_GRAPH_MAX_NODES` (`visual-graph.ts:24`). Above this the pane falls back to an adjacency list. |
| Layered default width | `40` cols | `[EXISTING]` `VISUAL_GRAPH_DEFAULT_WIDTH` (`visual-graph.ts:25`). |
| 2-D canvas top inset | `1` row | Matches `marginTop={1}` on `GraphPane` (`AbgOverlayPanesA.tsx:172`). |
| 2-D canvas left inset | `2` cols | Matches `marginLeft={2}` on the visual block (`AbgOverlayPanesA.tsx:175`). |
| Node box width | `14` cols | `[NEW]` Interior content width; leaves room for `<` `>` borders inside the 16-col grid cell. Dagre `nodesep` tuned so boxes never touch. |
| Node box height | `3` rows | `[NEW]` Row 0 top border `┌──…──┐`, row 1 `<id + glyph>`, row 2 bottom border `└──…──┘`. |
| Dagre `rankdir` | `'TB'` | `[NEW]` Top-to-bottom; matches the existing `│` / `▼` vertical connector convention. |
| Dagre `nodesep` | `2` cols | `[NEW]` Horizontal gap between same-rank nodes. |
| Dagre `ranksep` | `2` rows | `[NEW]` Vertical gap between ranks (room for the `│` connector + label row). |
| Dagre `marginx` / `marginy` | `1` / `1` | `[NEW]` Outer canvas padding. |
| Canvas bound | terminal cols − 4 | `[NEW]` Canvas never exceeds the pane width minus left/right insets; dagre output is clipped, not wrapped (see section 9). |

Node id is truncated to `10` cols (`[EXISTING]` `truncate(nodeId, 10)` in
`NodesPane`, `AbgOverlayPanesA.tsx:274`) and the status glyph + `[status]`
label sit on the content row, mirroring the layered row segment shape
(`✓ start [succeeded]`).

## 3. Minimap Dimensions

The minimap is `[NEW]`. It is a compact, always-visible summary panel that
shows the whole graph at a glance while the main canvas focuses on a region.

| Dimension | Value | Notes |
| --- | --- | --- |
| Width | `20` cols | Fits alongside the canvas in a ≥100-col terminal; one col per ~rank-column. |
| Height | `10` rows | Enough for ~6 ranks plus a 1-row header and border. |
| Position | upper-right of the graph pane | Anchored to the canvas top-right corner; never overlaps the `GraphPane` header line. |
| Border | single-line `┌─┐│└─┘` in dim | Reuses the overlay chrome, not a new glyph set. |
| Node dot | `1` cell | Each node collapses to a single status-colored cell (see section 4 glyph grammar). |
| Edge pixel | `·` (dim) or `:` (active path) | `[NEW]` Bresenham-style 1-cell edge trace between node dots. |
| Viewport rect | `[` `]` corners in `ACCENTS.default` (`#00ffff`) | `[NEW]` Marks the canvas's visible region inside the minimap. |
| Header text | `minimap` (dim, bold) | 1 row, left-aligned inside the top border. |

The minimap recomputes its dot positions from the **same** dagre layout pass
as the main canvas (shared coordinates, scaled down) so the two never drift.

## 4. Glyph Grammar

### Node status glyphs `[EXISTING]`

Defined centrally in `abg-status-theme.ts` (`nodeStatusTheme()`, lines 36-58).
`renderVisualGraph` (`visual-graph.ts:97`) and the React panes
(`AbgOverlayPanesA.tsx:187-189, 267-269`) both resolve glyphs through it, so
the layered list and the panes can no longer drift:

| Status | Glyph |
| --- | --- |
| `idle` | `∙` |
| `starting` | `○` |
| `running` | `▶` |
| `succeeded` | `✓` |
| `failed` | `✗` |
| `blocked` | `⏸` |
| `cancelled` | `⊘` |

### Edge connectors `[EXISTING]` (layered list) + `[NEW]` (2-D canvas)

| Context | Glyph | Source |
| --- | --- | --- |
| Single-edge vertical stem | `│` | `[EXISTING]` `visual-graph.ts:118` |
| Single-edge down arrowhead | `▼` | `[EXISTING]` `visual-graph.ts:119` |
| Multi-edge non-last branch | `├──►` | `[EXISTING]` `visual-graph.ts:128` |
| Multi-edge last branch | `└──►` | `[EXISTING]` `visual-graph.ts:128` |
| Collapsed adjacency marker | `└→` | `[EXISTING]` `AbgOverlayPanesA.tsx:205` |
| Child-graph marker | `↳` | `[EXISTING]` `AbgOverlayPanesA.tsx:228` |

The full box-drawing connector vocabulary available to the `[NEW]` 2-D canvas:

| Glyph | Use |
| --- | --- |
| `│` `─` | vertical / horizontal run |
| `┌` `┐` `└` `┘` | canvas + node-box corners |
| `├` `┤` `┬` `┴` `┼` | T and cross junctions where edges meet |
| `►` `◄` `▲` `▼` | arrowheads: right, left, up, down |

### Arrowheads `[NEW]` (2-D canvas)

Direction is derived from the dagre edge vector between two node-box centers.

| Direction | Glyph |
| --- | --- |
| down (default, `rankdir: TB`) | `▼` |
| up | `▲` |
| right | `►` |
| left | `◄` |

### Self-loop glyph `[NEW]`

A node that has an edge back to itself renders a `↻` glyph appended to its
content row (`▶ work ↻ [running]`), drawn in the node's status color. No
separate canvas loop arc is drawn — the glyph is the loop. This keeps the
self-loop readable at `14`-col box width without arc geometry.

### Node border glyphs `[NEW]` (2-D box)

| Border | Top | Bottom |
| --- | --- | --- |
| default | `┌────────────┐` | `└────────────┘` |
| active/changed (pulsing) | `╔════════════╗` | `╚════════════╝` |

The active node swaps single-line to double-line borders so it reads as
highlighted even in the low-color fallback (section 8), where color is gone.

## 5. Status Palette

### Graph status `[EXISTING]`

`graphStatusTheme()` (`abg-status-theme.ts:65-85`) is exhaustive over all six
`AbgGraphStatus` values (`packages/protocol/src/abg-constants.ts:31`) and
returns a `StatusTheme` with an explicit `foreground` for every status. The
`created`/`cancelled` pair shares `STATUS_FG_GRAY` (`abg-status-theme.ts:9`):

| `AbgGraphStatus` | Foreground | Source |
| --- | --- | --- |
| `created` | `#808080` (gray) | `[EXISTING]` `graphStatusTheme`, `STATUS_FG_GRAY` |
| `active` | `#ffff00` (yellow) | `[EXISTING]` `graphStatusTheme` |
| `blocked` | `#00ffff` (cyan) | `[EXISTING]` `graphStatusTheme` |
| `completed` | `#00ff00` (green) | `[EXISTING]` `graphStatusTheme` |
| `failed` | `#ff0000` (red) | `[EXISTING]` `graphStatusTheme` |
| `cancelled` | `#808080` (gray) | `[EXISTING]` `graphStatusTheme`, `STATUS_FG_GRAY` |

### Node status `[EXISTING]`

A single source: `nodeStatusTheme()` (`abg-status-theme.ts:36-58`) returns a
`StatusTheme` (`{ glyph, foreground?, background?, pulseStyle? }`,
`abg-status-theme.ts:24-29`) for each `AbgNodeStatus`. `foreground` is
optional — `idle` and `starting` carry none, so the caller renders them with
its own dim/default style. Glyphs are the ones listed in section 4. Both
`renderVisualGraph` (`visual-graph.ts:97`) and the React panes
(`AbgOverlayPanesA.tsx:187-189, 267-269`) resolve glyph + foreground through
`nodeStatusTheme`, so the layered list and the panes can no longer drift:

| `AbgNodeStatus` | Foreground |
| --- | --- |
| `idle` | `undefined` (dim, no `fg`) |
| `starting` | `undefined` (dim, no `fg`) |
| `running` | `#ffff00` (yellow) |
| `succeeded` | `#00ff00` (green) |
| `failed` | `#ff0000` (red) |
| `blocked` | `#00ffff` (cyan) |
| `cancelled` | `#808080` (gray, `STATUS_FG_GRAY`) |

A node's border, glyph, and `[status]` label all share one status color; a
node row may mix status-tinted segments (glyph, label) with neutral segments
(id, connectors) per `VisualGraphSegment.status` (`visual-graph.ts:27-36`).
The optional `foreground` (absent on `idle`/`starting`) is what the low-color
path in section 8 overrides with attributes.

## 6. Changed-Node Pulse

`[NEW]`. When a node's status transitions, the node box pulses once to draw
the eye, then settles.

| Property | Value |
| --- | --- |
| Duration | `1500` ms total, single cycle |
| Phase | `750` ms bright on, `750` ms dim off |
| Highlight attribute | `bold` + `bright` (opentui `TextAttributes.BOLD`) |
| Border during pulse | double-line `╔═╗╚═╝` (section 4) |
| Termination | pulse auto-clears after one cycle; no re-arm on re-render |
| Timer driver | `setInterval` bound to the React effect lifecycle (mirrors `useSpinnerFrame`, `spinner.ts:36-52`) |

Testability: pulse timing is driven by a single injected clock so unit tests
use Vitest fake timers (`vi.useFakeTimers()`) and advance with
`vi.advanceTimersByTime(1500)` rather than waiting real time. The pulse state
is a pure function of `(transitionTimestamp, now)` so it is deterministic
under faked time.

## 7. Reduced-Motion Behavior

`[EXISTING]` pattern. The renderer is **static by default** to avoid per-frame
redraws disrupting terminal text selection (`spinner.ts:4-8`). Animation is
opt-in via `MCTRL_SPINNER=animate`; the spinner's static glyph is `●`
(U+25CF, `SPINNER_STATIC_GLYPH`).

The graph canvas and minimap inherit the same rule:

| Mode | Pulse behavior | Spinner behavior |
| --- | --- | --- |
| `static` (default, or `MCTRL_SPINNER` unset) | pulse is replaced by a **static** double-line border + `bold` that persists until the next status change | running node shows `●` |
| `animate` (`MCTRL_SPINNER=animate`) | full `1500` ms bright/dim pulse cycle (section 6) | running node shows the `80` ms braille cycle (`SPINNER_FRAMES`) |

A node is "changed" only on a real status transition, not on every store
snapshot. In reduced-motion (static) mode the changed node keeps its
double-line border until a different node changes; this is the no-animation
fallback the contract guarantees.

The pulse never schedules a timer in `static` mode — it is pure attribute
state. This is the same discipline `useSpinnerFrame` already follows
(`spinner.ts:40-41` early-returns before scheduling).

## 8. Low-Color Fallback

`[NEW]`. When the terminal advertises fewer than 256 colors (or the operator
sets a `MCTRL_NO_COLOR` style flag mirroring the markdown `noColorTheme` in
`src/components/markdown/theme.ts`), rendering switches from hex/256-color
codes to SGR **attributes** only:

| Element | True-color form | Low-color form |
| --- | --- | --- |
| Node border (default) | single-line `┌┐└┘` | same glyphs, no color |
| Node border (active/changed) | double-line `╔╗╚╝` in status color | double-line, **`bold`** attribute |
| Running node | `▶` yellow | `▶` **`bold`** |
| Succeeded node | `✓` green | `✓` (default attrs) |
| Failed node | `✗` red | `✗` **`bold`** |
| Blocked node | `⏸` cyan | `⏸` **`reverse`** |
| Cancelled node | `⊘` gray | `⊘` **`dim`** |
| Idle / starting node | `∙` / `○` dim | glyph, **`dim`** |
| Connector | `│▼├└►` dim | glyph, **`dim`** |
| Minimap viewport rect | `[` `]` cyan | `[` `]` **`bold`** |

Status discrimination survives without color via four distinct attributes
(`bold`, `reverse`, `dim`, default) plus double-line borders for the active
node. The single `foreground` source in `nodeStatusTheme()`
(`abg-status-theme.ts`) is what this path overrides: where the theme carries
no `foreground` (`idle`, `starting`) the low-color renderer already emits
`dim`, and for the rest it substitutes the attribute in the table above.

## 9. Terminal-Size Behavior

`[EXISTING]` collapse gate plus `[NEW]` graph clipping.

| Threshold | Behavior | Source |
| --- | --- | --- |
| `< 100` cols | `shouldCollapseToOverview` returns `true`; overlay drops to the Overview tab only and shows a "Terminal too narrow" hint. | `[EXISTING]` `NARROW_THRESHOLD=100`, `AbgOverlay.tsx:31, 37-38` |
| `100`–`119` cols | full 8-tab overlay; graph canvas uses the layered 1-D list only (no 2-D canvas side-by-side with minimap). | `[NEW]` |
| `≥ 120` cols | 2-D dagre canvas + minimap render side by side; canvas width = terminal cols − minimap width (`20`) − insets (`4`). | `[NEW]` |
| Node count `> 16` | graph falls back to the adjacency-list renderer. | `[EXISTING]` `VISUAL_GRAPH_MAX_NODES`, `visual-graph.ts:78-79` |
| Very large graph (canvas wider than bound) | dagre output is **clipped** to the canvas bound (section 2), never wrapped. Off-canvas nodes are summarized in the minimap as dim dots; the viewport rect shows the visible region. | `[NEW]` |

The normalized `TerminalViewport` is the source of truth for width. A resize
re-runs the collapse decision from viewport columns and, when not collapsed,
re-runs the dagre layout at the new bound. The minimap always renders the full
graph regardless of canvas clipping so the operator can see what is off-screen.

Vertical behavior mirrors horizontal: rows beyond the pane height scroll
inside the existing native `<scrollbox>`; the minimap's viewport rect tracks
the vertical scroll position.

## 10. Chat Bottom-Dock Primitive

`ChatApp` owns the full chat screen topology: one flex-growing upper output
region, one `ChatBottomDock` sibling, and any global/modal overlays outside the
dock. The split is a responsibility contract, not a new visual language.

The upper output region owns `WelcomeScreen` or `ChatTranscript`,
`AgentSpinner`, `Toast`, and `AbgMinimap`. `Toast` stays anchored in this upper
region above the dock so transient notices never consume prompt rows.

The bottom dock owns, in order, `TopStatusBar`, the prompt-adjacent slash menu,
workflow menu, and file autocomplete panels, the `QuestionOverlay` or
`ChatInputArea` slot, and `BottomStatusBar`. `ChatInputArea` remains the native
textarea boundary for text, cursor, paste, submit, history, and prompt-panel
interactions; the dock composes it and forwards refs rather than replacing input
semantics.

Full-screen overlays (`abg`, `diff-viewer`, `models-overlay`) remain early
returns in `ChatApp`. Modal overlays (`approval`, `model-picker`,
`level-picker`, `rename`, `session-picker`, `agents-dashboard`,
`mission-panel`) remain outside `ChatBottomDock` and are routed by `ChatApp`.
Do not move global/modal overlay responsibility into the dock.

Bottom-dock layout policy is deterministic by terminal size:

| Policy | Contract |
| --- | --- |
| Width classes | `<66` narrow, `66-79` compact, `80-119` normal, `120-149` wide, `>=150` spacious. |
| Status visibility | Context usage and project show at `>=80`; session shows at `>=120`. |
| Menu footer | Prompt-panel footers show at `>=66` when menu rows are available. |
| Minimum reservation | At least `4` transcript rows, `2` status rows, and `1` input row are reserved before allocating prompt-panel menu rows. |

Status rows render with `STATUS_LINE_BG` and `APPROVAL_LEVEL_COLORS`.
Prompt-adjacent slash/workflow/file panels render through `OverlayFrame` and use
`SELECTED_BG` for selection. Question and modal accents come from `ACCENTS` and
the existing `OverlayFrame` chrome. No component in the dock may add a raw
visual token when an existing token covers the role.
