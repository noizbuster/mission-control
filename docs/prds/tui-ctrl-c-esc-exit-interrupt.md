# PRD: TUI keyboard: Ctrl+C exit, ESC interrupt-only, multi-line input

| Field | Value |
| --- | --- |
| Status | active |
| Scope | Keyboard router (`handleInput`, `handleEscKey` in `ink-chat-bridge.tsx`), the interrupt event flow into the main chat loop (`interactive-chat.ts`), and multi-line input triggers |
| Related plans | `.omo/plans/ulw-input-korean-ctrlc.md` |

## Background

Ctrl+C was not terminating the session reliably, ESC was exiting the CLI instead of only interrupting the active run, first-press produced no visible feedback, and combo detection relied on timing windows rather than key sequences. The target behavior is a model where ESC is purely a stop-only key, exit is exclusively Ctrl+C, and multi-line input works across terminals without requiring kitty keyboard protocol.

A regression at commits `950227d` (single-Esc interrupts while generating) and `507809a` (default double-Esc action changed from `'interrupt'` to `'none'`) removed the user's ability to force-stop stuck runs via double-Esc. The default-`'none'` choice was motivated by the main loop treating every `interrupt` event as an exit candidate on second consecutive press when idle, which meant mashing Esc on an empty prompt would exit. The correct fix is not to neuter ESC, but to differentiate ESC-sourced interrupts from Ctrl+C-sourced at the event level so ESC can stop without ever exiting.

Multi-line input (Shift+Enter) also regressed because Ink v7's `key.shift` flag is only set when the terminal sends kitty keyboard protocol or modifier-encoded ANSI sequences for Enter. Most common terminals (xterm, gnome-terminal, Terminal.app without modifyOtherKeys) send a plain `\r` for Shift+Enter, making it indistinguishable from plain Enter. A reliable cross-terminal multi-line trigger is needed.

## Goals

- Ctrl+C is the only exit path and works reliably with first-press feedback.
- ESC only stops the active run (or attempts to force-stop a stuck run); it never exits the CLI.
- Multi-line input works across all terminals, not only kitty-protocol terminals.

## Non-Goals

- Removing the existing ESC handling branches (model picker, rename mode, approval mode).
- Sequence-based multi-key combos (Ctrl+X then another key) — deferred.

## Requirements

1. Ctrl+C terminates the session and agent reliably. First press produces visible feedback (status change or message) even when nothing else visibly changes; second consecutive press while idle exits.
2. ESC never exits the CLI, regardless of how many times it is pressed or what state the run is in.
3. Single ESC press while the agent is actively generating interrupts the current run immediately.
4. Double ESC within a 500ms window emits an interrupt event by default, force-stopping runs that are stuck outside the streaming state. `MCTRL_DOUBLE_ESC_ACTION=none` disables double-Esc entirely; `=tree` enqueues `/tree`; `=fork` enqueues `/fork`.
5. ESC-sourced interrupts and Ctrl+C-sourced interrupts are differentiated at the `ChatInputEvent` level via a `source: 'esc' | 'ctrl-c'` field. The main chat loop uses this field to decide whether the event may trigger an exit. ESC-sourced events never count toward the "press twice to exit" path; Ctrl+C-sourced (and legacy undefined-source) events preserve the existing exit contract.
6. Multi-line input is triggered by either Shift+Enter (kitty-protocol terminals) or Alt+Enter (any terminal that distinguishes the `\x1b\r` Alt+Enter sequence from plain Enter). Both insert a newline into the input buffer without submitting.
7. Plain Enter (no Shift, no Alt) always submits the current input buffer, including multi-line buffers built via Shift+Enter or Alt+Enter.

## Acceptance Criteria

- First Ctrl+C press always produces visible feedback.
- ESC cannot be made to exit the CLI, even by mashing it on an empty idle prompt.
- Double-ESC force-stop works by default (no env opt-in required); `MCTRL_DOUBLE_ESC_ACTION=none` disables it.
- The interrupt event carries `source: 'esc'` when triggered by ESC (single-press generating case, double-press default case) and `source: 'ctrl-c'` when triggered by Ctrl+C or Ctrl+D-on-empty.
- Alt+Enter inserts a newline on a default terminal that does not support kitty protocol; Shift+Enter still inserts a newline on kitty-protocol terminals.
- Plain Enter submits the buffer; the buffer's multi-line contents are submitted as a single line event containing `\n` separators.
