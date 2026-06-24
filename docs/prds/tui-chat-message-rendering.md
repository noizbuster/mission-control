# PRD: TUI chat message rendering: visual identity, multi-line bars, and agent processing state

| Field | Value |
| --- | --- |
| Status | draft |
| Scope | Message block renderers (`apps/cli/src/components/*`) and the markdown pipeline (`apps/cli/src/components/markdown/`) |
| Related plans | `.omo/plans/tui-rich-rendering.md` |

## Background

Message blocks (user, assistant, thinking, error, tool) lacked visual separation; multi-line responses only showed the colored left bar on a single row instead of spanning the block; and the agent's thinking-vs-streaming state was not visible to the user.

## Goals

- Each message kind has a distinct, at-a-glance visual identity.
- Multi-line blocks render as a single contiguous unit.
- The agent's processing state is visible while it is working.

## Non-Goals

- Changing the `parseMessageBlocks` classification contract.
- Removing the trailing-window budget / truncation behavior.

## Requirements

1. Each message kind (user, assistant, thinking, error, tool) renders inside a borderless dark box.
2. The box's left edge uses a per-kind color so kinds are distinguishable at a glance.
3. Multi-line responses extend the colored left bar across every line of the block (current behavior shows the bar on only one row).
4. While the agent is working, surface an indicator that distinguishes "thinking" from "streaming the response".
5. The rendering contract is captured in a design note so future agents can reference it without re-deriving it from code.

## Acceptance Criteria

- Each message kind has a visually distinct borderless box with a per-kind left-edge color.
- A multi-line assistant response shows the colored bar on every line.
- A visible indicator distinguishes thinking vs streaming states.
