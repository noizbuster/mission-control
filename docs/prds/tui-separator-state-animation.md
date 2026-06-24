# PRD: TUI separator: animated run-state indicator

| Field | Value |
| --- | --- |
| Status | draft |
| Scope | Separator line renderer between the message area and the input area |

## Background

The static separator between input and output did not communicate run state, leaving the user to infer whether the agent was running, awaiting input, or idle from other cues.

## Goals

- The separator visualizes run state at a glance.

## Non-Goals

- Replacing the existing dim separator style.

## Requirements

1. The separator animates to expose run state: `running`, `awaiting user input`, `idle`.
2. The animation must not introduce perceptible input latency on the typing path.

## Acceptance Criteria

- Three distinct separator states are visible corresponding to running / awaiting input / idle.
- Typing latency is unchanged after the animation is added.
