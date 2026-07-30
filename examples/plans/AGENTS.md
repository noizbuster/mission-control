<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# plans

## Purpose

Reference examples of the agent `writePlan` markdown format (TL;DR, TODOs, Final Verification Wave). Not live execution state — runtime plans live under `.mc/plans/` (gitignored). Used to document and test checklist parsing expectations (`parsePlanChecklistText`).

## Key Files

| File | Description |
|------|-------------|
| `example-plan.md` | Sample plan `add-session-search`: `## TL;DR`, column-0 `- [ ]` TODOs, reviewer Final Verification Wave checkboxes |

## Subdirectories

None.

## For AI Agents

### Working In This Directory
- Preserve heading names and checkbox shape expected by plan admission / checklist parsers:
  - `## TL;DR`
  - `## TODOs` with unchecked `- [ ]` items at column 0
  - `## Final Verification Wave` with reviewer checkboxes at column 0
- Do not treat these files as the source of truth for product work; they are format samples.
- Live boulder/plan persistence is `packages/core` persistence + `.mc/plans/`.

### Testing Requirements
- Exercised indirectly via core plan-scaffold / admission / checklist parsers when those tests embed or mirror this shape.
- No local test runner in this directory.

### Common Patterns
- Title H1 = short plan slug/name.
- TODO lines are actionable engineering steps; verification wave lines are reviewer acceptance checks.

## Dependencies

### Internal
- `packages/core/src/persistence` plan scaffold / boulder types
- `packages/core/src/behavior/executer-plan-admission.ts` — admission expectations around plan structure
- PRD/process notes in `docs/prds/`

### External
- None

<!-- MANUAL: -->
