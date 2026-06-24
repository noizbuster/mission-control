# PRD: TUI slash command autocomplete: partial-typing resolution and overlay rendering

| Field | Value |
| --- | --- |
| Status | draft |
| Scope | Slash command autocomplete menu (`interactive-chat-command-menu.ts`) |

## Background

Slash command autocomplete required exact input to resolve and rendered inside the chat area as growing inline text rather than as a popup overlay. The target is a modal-style picker that floats over the chat area, resolves partial input on Enter, and never pushes chat content down while open.

## Goals

- Partial typing resolves to the highlighted command.
- Command picker renders as a modal overlay, not as chat output.

## Non-Goals

- Replacing the existing `createSlashCommandMenuView` filter/sort logic.

## Requirements

1. The command picker renders as a modal dialog overlay above the chat area, not as inline text growing in the chat scrollback. While the picker is open the chat scrollback must not advance.
2. The picker shows a filter input at the top; typing narrows the visible command list by substring match on the command name (and optionally its description).
3. Each visible option row shows: command title, optional description, optional category, and a footer slot for the bound keybindings (e.g. `Enter`, `Esc`).
4. When the filter is empty, suggested / recommended commands are promoted into a separate `Suggested` category at the top of the list, ahead of the full command listing.
5. Partial input + Enter resolves to the currently highlighted match via the existing `resolveSlashCommandMenuSubmission` resolver and dispatches it; the picker closes immediately on dispatch.
6. `Esc` closes the picker without dispatching and returns focus to the input buffer with its prior contents intact.
7. Arrow Up/Down moves the highlight inside the picker list; wrapping at the top/bottom is permitted.
8. The picker is dismissed (cleared from the screen) the moment a command is dispatched or cancelled — no leftover frame is left in the chat region.

## Acceptance Criteria

- Typing `/ex` + Enter runs `/exit`.
- The picker is rendered as an overlay and never appears inside the chat scrollback.
- Opening the picker does not push previously-rendered chat content upward.
- `Esc` returns the user to the input buffer with the partial text preserved.
