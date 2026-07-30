<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# tui-stores

## Purpose

Filesystem-backed TUI preference/state stores: KV, local preferences, prompt history/stash, theme preference, plugin manifest cache, and frecency — with shared JSON/JSONL file I/O helpers and entry caps.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Public exports for all stores |
| `store-file-io.ts` | Optional text read, JSON/JSONL encode/parse helpers |
| `tui-kv-store.ts` | Generic capped KV store |
| `local-preferences-store.ts` | `TuiLocalPreferencesStore` |
| `prompt-history-store.ts` | Prompt history ring/cap |
| `prompt-stash-store.ts` | Prompt stash entries |
| `theme-preference-store.ts` | Theme preference + overrides |
| `plugin-manifest-store.ts` | Cached plugin manifest entries |
| `frecency-store.ts` | Frecency scoring store |
| `tui-store-test-support.ts` | Shared test helpers |
| `*.test.ts` | Per-store tests |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Respect per-store `*_MAX_ENTRIES` caps — evict deterministically.
- Use `store-file-io` for parse/serialize; fail soft on missing files (`readOptionalTextFile`).
- Stores are TUI/process-local preferences — not the durable session event log (`../memory/`).
- Keep schemas/zod validation at store boundaries where present.

### Testing Requirements

- One `*.test.ts` beside each store; use `tui-store-test-support.ts`

### Common Patterns

- load → mutate in memory → atomic/replace write
- JSONL for append-friendly histories; JSON for small preference blobs

## Dependencies

### Internal

- Apps TUI (`apps/tui`) as primary consumer
- `../plugins/` may feed plugin manifest store
- Node fs via helpers

### External

- Zod where store records are schema-validated

<!-- MANUAL: -->
