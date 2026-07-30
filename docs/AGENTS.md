<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# docs

## Purpose

Long-form product and design documentation that complements root `README.md` and `ABG.md`. Covers ABG theory (Korean), session data model, tool/permission layering, plugin/workflow authoring, desktop ABG monitor scaffold design, ABG reference parity status, and distilled PRDs.

## Key Files

| File | Description |
|------|-------------|
| `ABG.ko.md` | Korean ABG theory/design reference (execution model philosophy) |
| `session-data-model.md` | Authoritative local libSQL session/run/job storage model |
| `tool-permission-model.md` | Advertising vs approval vs skills — three-layer permission SoT |
| `plugin-authoring.md` | Workflow authoring guide (`*.workflow.json[c]`, modes, discovery) |
| `abg-reference-parity-matrix.md` | 22-row ABG parity status matrix vs built-in workflows |
| `v2-desktop-abg-monitor.md` | Deferred desktop ABG monitor integration design (scaffold) |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `prds/` | Product requirement docs distilled from request history (see `prds/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Prefer updating these docs when changing the contracts they describe (session SQL, permissions, workflow schema, parity rows).
- Root `tests/readme-*.test.ts`, `abg-root.test.ts`, and related contract tests may lock phrases in sibling root docs; keep `docs/` aligned with implementation symbols.
- `tool-permission-model.md` is the SoT for capability advertising vs permission vs skills — do not collapse layers in code or docs.
- `session-data-model.md`: SQL `mission-control.db` is authoritative; JSONL is archive export/import only.
- PRDs capture *what/why*; execution plans live under `.mc/plans/` (gitignored agent state), not here.

### Testing Requirements
- No dedicated docs test target. Contract coverage is indirect via root `tests/readme-*.test.ts`, `tests/abg-root.test.ts`, `tests/abg-boundary.test.ts`, and core `abg-reference-parity.test.ts`.
- After permission/session/workflow doc edits, run the matching contract tests if wording is locked.

### Common Patterns
- Markdown only; no build step.
- Cross-link implementation paths (`packages/core/...`, `examples/abg/...`) with concrete symbols.
- Status vocabulary in parity matrix: `implemented` / `partial` / `deferred`.

## Dependencies

### Internal
- Design anchors: root `ABG.md`, `README.md`
- Implementation mirrors: `packages/protocol`, `packages/core`, `apps/tui`, `apps/desktop`, `examples/abg`
- Authoring example: `examples/abg/custom-example.workflow.jsonc`

### External
- None (documentation only)

<!-- MANUAL: -->
