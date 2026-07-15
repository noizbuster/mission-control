# Mission Control Desktop Design System

## 1. Atmosphere & Identity

Mission Control Desktop is a compact operational console: light, precise, and intentionally utilitarian. Warm yellow actions, pale semantic status surfaces, and a dark output plane distinguish active control from passive inspection without changing the three-column workspace layout.

## 2. Color

| Role | Token | Usage |
| --- | --- | --- |
| Page surface | `--bg` | Application background |
| Panel surface | `--panel` | Console panels and controls |
| Recessed surface | `--rail` | Inspector and secondary status surfaces |
| Primary text | `--ink` | Headings and body copy |
| Muted text | `--muted` | Labels and metadata |
| Default border | `--border` | Panel separation |
| Strong border | `--border-strong` | Inputs and selected states |
| Action | `--accent`, `--accent-hover` | Primary buttons |
| Success | `--ok`, `--ok-border` | Healthy state |
| Warning | `--warn`, `--warn-border` | Operator attention required |
| Error | `--danger`, `--danger-border` | Failure and destructive state |
| Code | `--code` | Terminal-style output |

New recovery UI uses the existing warning and error tokens only.

## 3. Typography

- Primary: `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans CJK KR", sans-serif`
- Page title: 32px, bold, 1.1 line height
- Panel title: 15px, bold, 1.2 line height
- Body: inherited system size
- Metadata: 13-14px, bold, muted
- Code: inherited monospace `pre` rendering

## 4. Spacing & Layout

- Base unit: 4px.
- Existing density steps: 4px, 8px, 10px, 12px, 14px, 16px, 22px. The inspector recovery notice scopes `--inspector-space-2` (8px), `--inspector-space-3` (12px), and `--inspector-focus-offset` (2px) to preserve that rhythm.
- Layout: centered shell capped at 1480px; session list, timeline/output stack, and utility rail at wide widths; one column at 1280px and below.
- Scroll ownership: each session list, timeline, and utility rail owns its own overflow. The page shell remains document-scrolled.

## 5. Components

### Inspector Recovery Notice

- Structure: warning panel, effect identity metadata, operator action cluster.
- Variants: unresolved `unknown` only; completed or failed operator resolution is removed after refresh.
- Spacing: existing compact 8px and 12px inspector rhythm.
- States: default, resolving, failure message through the composer action status, and resolved removal.
- Accessibility: labelled recovery region, visible keyboard focus, descriptive action labels, disabled conflicting actions while one resolution is pending.
- Layout: utility-rail stack; no independent scroll owner.

### Approval Queue

- Structure: approval identity, preview, and pending approve/deny actions.
- Variants: pending actions only; terminal approval decisions remain history.
- Accessibility: semantic buttons with visible labels.

## 6. Motion & Interaction

- No decorative motion.
- Buttons use the existing hover color and browser-visible focus treatment.
- Disabled state communicates an active write without moving layout.

## 7. Depth & Surface

- Strategy: borders-only.
- Panels use `--panel` with `--border`; semantic notices use the matching background and border token pair.
- Selected sessions retain the existing inset border treatment.

## 8. Accessibility Constraints & Accepted Debt

- WCAG target: 2.2 AA. Every action is keyboard reachable, exposes a visible label, and keeps its focus indicator.
- The UI must reflow to one column without horizontal primary-content overflow at 375px.
- Accepted debt: the inherited global stylesheet contains historical raw spacing and color values outside this document. This change adds no new raw visual values; consolidation is out of scope for the recovery boundary work.
- React developer tooling is not added because this task explicitly forbids new dependencies.
