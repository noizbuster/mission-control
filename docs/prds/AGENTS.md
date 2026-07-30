<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# prds

## Purpose

Product requirement docs distilled from project request history. Each PRD states the *what* and *why* of one theme; execution plans live under `.mc/plans/` (gitignored agent state), not here. Index and counts are maintained in `README.md`.

## Key Files

| File | Description |
|------|-------------|
| `README.md` | Index table: PRD ↔ theme ↔ requirement count (23 PRDs / 97 requirements at last index) |
| `abg-graph-edge-rendering.md` | ABG graph view: render node-to-node edges |
| `abg-graph-overlay-visualization.md` | ABG overlay: per-node state labels + active spinner |
| `approval-auto-approve-aggressive.md` | Auto-approve `command.run` under aggressive approval level |
| `approval-level-ui-and-realtime-policy.md` | Visible approval level + real-time policy application |
| `auth-api-key-input-visibility.md` | API key entry progress without revealing the secret |
| `bug-react-key-collision-model-picker.md` | Model picker React key collision (`provider: zai-co`) |
| `build-core-failure-and-dev-cli-prebuild.md` | Core build failures + `dev:cli` pre-build hook |
| `build-nx-tui-blocking-interactive.md` | Stop nx TUI from blocking interactive `pnpm dev:cli` |
| `models-api-driven-list-when-logged-in.md` | Models command: live API list, comparison, quieter markers |
| `models-discovery-consistency.md` | Unify model lists; provider list as superset; picker popup |
| `provider-errors-non-fatal.md` | Provider errors visible, non-fatal, human-readable |
| `rendering-full-fidelity.md` | Full-fidelity markdown/diff/message styling |
| `sessions-failure-investigation.md` | Diagnose/fix/surface mctrl session failures |
| `subagent-task-yield-missing.md` | Yield guard, task schema normalize, child SQL observability |
| `tui-chat-message-rendering.md` | Chat message visual identity and agent processing state |
| `tui-ctrl-c-esc-exit-interrupt.md` | Ctrl+C exit, ESC interrupt-only, multi-line input |
| `tui-ink-migration.md` | Historical TUI library migration / drift audit |
| `tui-input-output-separation.md` | Input area visual separation |
| `tui-output-window-stability.md` | Prevent irregular output loss during runs |
| `tui-prompt-history-recall.md` | Arrow-key prompt history recall |
| `tui-separator-state-animation.md` | Animated run-state separator |
| `tui-slash-command-autocomplete.md` | Slash-command partial resolve + overlay |
| `tui-workflow-autocomplete-ux.md` | Workflow autocomplete inserts prefix without executing |

## Subdirectories

None.

## For AI Agents

### Working In This Directory
- PRDs are requirements sources of truth for *product intent*, not live implementation specs. Code wins on current behavior; update PRDs when intent changes.
- When adding a PRD: new `*.md` + row in `README.md` index; keep requirement bullets countable.
- Do not store execution checklists here — use `.mc/plans/` or `examples/plans/` (format samples only).
- Cross-link related code areas in the PRD body when known (`apps/tui`, `packages/core`, …).

### Testing Requirements
- No automated test suite for PRD markdown. After intent changes, verify implementing code/tests still match the stated requirements.

### Common Patterns
- Filename: kebab-case theme (`area-concern.md`).
- Body: problem/context, requirements list, non-goals as needed.
- README index columns: PRD link | Theme | Requirements count.

## Dependencies

### Internal
- Parent `docs/` design refs (`ABG.ko.md`, `tool-permission-model.md`, …)
- Implementing surfaces: `apps/tui`, `apps/cli`, `apps/desktop`, `packages/core`
- Plans: `.mc/plans/` (runtime), `examples/plans/` (format example)

### External
- None

<!-- MANUAL: -->
