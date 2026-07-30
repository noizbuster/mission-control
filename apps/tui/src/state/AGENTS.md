<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# state

## Purpose

Framework-free TUI state cluster: `ChatStore`, transcript parts, display sanitizer, handle/options types, CLI-injected `ChatAppActions`, selector store, overlays/pickers state, ABG overlay state, and pure interactive helpers. Exported via `@mission-control/tui/state` for eager CLI type/import without loading OpenTUI.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Barrel re-export |
| `chat-store.ts` | `ChatStore` external store (`subscribe`/`getSnapshot`); `emitTranscriptPart` / `replaceTranscript` |
| `transcript-part.ts` | TUI-local `TranscriptPart` union + stable-ID upsert |
| `transcript-visibility.ts` / `transcript-fallback.test.ts` | Visibility + legacy fallback coverage |
| `terminal-display-sanitizer.ts` | Display-only credential redaction + control escaping |
| `chat-tui-types.ts` | `ChatTuiHandle`, `ChatTuiRuntimeOptions` |
| `chat-app-actions.ts` | `ChatAppActions` callback interface (CLI-injected) |
| `chat-input-event.ts` | `ChatInputEvent` types |
| `chat-selector-store.ts` | Generic selector-store helpers |
| `approval-level.ts` | Approval level UI state |
| `models-overlay-state.ts` | Models overlay state |
| `history-picker-state.ts` / `history-picker-format.ts` | History picker state/format |
| `interactive-chat-command-menu.ts` | Slash command menu model |
| `interactive-chat-file-autocomplete.ts` | File autocomplete model |
| `interactive-chat-model.ts` | Model picker pure helpers |
| `interactive-chat-terminal-keys.ts` | Terminal key classification helpers |
| `interactive-chat-cursor-navigation.ts` | Cursor nav pure helpers |
| `abg-overlay-state.ts` / `abg-overlay-controller.ts` / `abg-overlay-prefs-store.ts` | ABG overlay state/controller/prefs |
| `tool-call-aggregation.ts` | Tool-call aggregate helpers |
| `list-windowing.ts` | List windowing math |
| `separator-state.ts` | Separator UI state |
| `model-capability.ts` | Model capability flags for UI |
| `mission-services-types.ts` | `MissionControlServicesLike` structural type |
| `welcome-data-types.ts` | Welcome panel data types |
| `auth-provider-keypress.ts` (+ escape/types/view) | Auth provider keypress pure UI state |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory
- **No** `@opentui/*` or `solid-js` runtime imports — enforced by package conventions / import-graph tests.
- `getSnapshot()` referentially stable between publishes; `publishSnapshot()` allocates next object.
- Raw execution/history/permission/answer/topology values stay unsanitized; sanitizer is display-only (keeps LF + normal Unicode/CJK).
- Components must not mutate store fields ad hoc; editing goes through textarea + dedicated handlers.

### Testing Requirements
- Framework-free `*.test.ts`: `chat-store`, `chat-selector-store`, `transcript-fallback`, `tool-call-aggregation`, overlay/picker/model/keys/abg tests.
- Keep tests Node-runnable without OpenTUI native.

### Common Patterns
- Stable transcript IDs; same-ID upsert preserves order.
- CLI imports types/helpers from this barrel eagerly; mount stays lazy.

## Dependencies

### Internal
- Consumed by `create-chat-tui`, components, platform selectors, and `apps/cli` (types + event shapes)
- No reverse imports from CLI implementation modules

### External
- None (pure TS)

<!-- MANUAL: -->
