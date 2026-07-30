<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# ui

## Purpose

Noninteractive CLI output: plain, buffered-TUI-summary, JSON, and JSONL renderers plus block/session formatting. This is **not** the OpenTUI Solid app (`apps/tui`).

## Key Files

| File | Description |
|------|-------------|
| `renderers.ts` | `AgentUIRenderer` interface; plain / TUI-summary / JSON renderer contracts |
| `renderers.test.ts` | Renderer contract tests |
| `renderers-redaction.test.ts` | Ensures no raw secrets in rendered output |
| `renderers-streaming.test.ts` | Streaming event rendering |
| `block-renderer.ts` | Renders structured output blocks to plain text |
| `output-blocks.ts` | Output block model / aggregation |
| `json-machine-state.ts` | JSON/JSONL machine-state emission helpers |
| `session-finalize.ts` | End-of-session finalize formatting |
| `session-status-format.ts` | Session status line formatting |
| `ui-adapter.ts` | Thin adapter between run path and renderer selection |
| `terminal-global-policy.test.ts` | Policy guard for terminal global usage in this tree |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory
- Consume protocol/core events only — never private runtime fields.
- Output is already redacted upstream in `packages/core`; never read raw provider/tool structured secrets here.
- `process.stdout.columns/rows` is allowed for noninteractive layout here; interactive components must use OpenTUI dimensions instead.
- Do not import `@opentui/*` or `apps/tui` components.

### Testing Requirements
- `renderers*.test.ts`, `block-renderer.test.ts`, `output-blocks.test.ts`, `session-*.test.ts`.
- Update tests when event ordering, redaction, or help/status strings change.

### Common Patterns
- Renderer selected by run mode (`plain` / summary / `json` / `jsonl`).
- Streaming vs finalize paths stay separate (`session-finalize`).

## Dependencies

### Internal
- `packages/protocol` — `AgentEvent` and related
- `packages/core` — already-redacted event stream from run path
- `../commands` — constructs/feeds renderers

### External
- None

<!-- MANUAL: -->
