# Mission Control PRDs

Product requirements distilled from the user's request history on this project. Each PRD captures the *what* and *why* of a coherent theme; execution plans live under `.omo/plans/*.md`.

## Index

| PRD | Theme | Requirements |
| --- | --- | ---: |
| [`abg-graph-edge-rendering.md`](abg-graph-edge-rendering.md) | ABG graph view: render node-to-node edges, not just the node list | 3 |
| [`abg-graph-overlay-visualization.md`](abg-graph-overlay-visualization.md) | ABG overlay: per-node colored state labels and active-node spinner | 2 |
| [`approval-auto-approve-aggressive.md`](approval-auto-approve-aggressive.md) | Approval system: auto-approve `command.run` under aggressive level | 3 |
| [`approval-level-ui-and-realtime-policy.md`](approval-level-ui-and-realtime-policy.md) | Approval system: visible level state and real-time policy application | 3 |
| [`auth-api-key-input-visibility.md`](auth-api-key-input-visibility.md) | Auth flow: show input progress during API key entry without revealing the value | 2 |
| [`bug-react-key-collision-model-picker.md`](bug-react-key-collision-model-picker.md) | Bug: React key collision in model picker (`provider: zai-co`) | 3 |
| [`build-core-failure-and-dev-cli-prebuild.md`](build-core-failure-and-dev-cli-prebuild.md) | Build pipeline: fix core build failures and add dev:cli pre-build hook | 2 |
| [`build-nx-tui-blocking-interactive.md`](build-nx-tui-blocking-interactive.md) | Build pipeline: stop nx TUI from blocking interactive `pnpm dev:cli` | 2 |
| [`tui-ink-migration.md`](tui-ink-migration.md) | Ink TUI library: full adoption and migration of legacy terminal code | 5 |
| [`models-api-driven-list-when-logged-in.md`](models-api-driven-list-when-logged-in.md) | Models command: prefer live API list, expose comparison, hide verbose markers by default | 4 |
| [`models-discovery-consistency.md`](models-discovery-consistency.md) | Models command: unify lists, treat provider list as superset, render picker as popup | 3 |
| [`provider-errors-non-fatal.md`](provider-errors-non-fatal.md) | Provider errors: visible, non-fatal, with parsed human-readable messages | 3 |
| [`rendering-full-fidelity.md`](rendering-full-fidelity.md) | Rendering: full-fidelity markdown, diff, and message styling | 18 |
| [`sessions-failure-investigation.md`](sessions-failure-investigation.md) | Session reliability: diagnose, fix, and surface root cause for failing mctrl sessions | 5 |
| [`tui-chat-message-rendering.md`](tui-chat-message-rendering.md) | TUI chat message rendering: visual identity, multi-line bars, and agent processing state | 5 |
| [`tui-input-output-separation.md`](tui-input-output-separation.md) | TUI input area: visual separation from surrounding context | 3 |
| [`tui-ctrl-c-esc-exit-interrupt.md`](tui-ctrl-c-esc-exit-interrupt.md) | TUI keyboard: Ctrl+C exit, ESC interrupt-only, multi-line input | 7 |
| [`tui-output-window-stability.md`](tui-output-window-stability.md) | TUI output window: prevent irregular content loss during runs | 3 |
| [`tui-prompt-history-recall.md`](tui-prompt-history-recall.md) | TUI prompt history: arrow-key recall with continuous advancement | 3 |
| [`tui-separator-state-animation.md`](tui-separator-state-animation.md) | TUI separator: animated run-state indicator | 2 |
| [`tui-slash-command-autocomplete.md`](tui-slash-command-autocomplete.md) | TUI slash command autocomplete: partial-typing resolution and overlay rendering | 8 |
| [`tui-workflow-autocomplete-ux.md`](tui-workflow-autocomplete-ux.md) | TUI workflow autocomplete: insert prefix without executing | 3 |

_Total: 22 PRDs, 92 requirements._
