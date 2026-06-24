# PRD: TUI workflow autocomplete: insert prefix without executing

| Field | Value |
| --- | --- |
| Status | draft |
| Scope | Workflow autocomplete menu when input starts with `#` |

## Background

Selecting a workflow via `#` and Enter executed immediately instead of letting the user continue typing the prompt after the workflow prefix.

## Goals

- Workflow selection inserts the prefix into the buffer without executing.

## Non-Goals

- (none stated)

## Requirements

1. Arrow + Enter on a workflow inserts `#<name> ` into the input buffer.
2. The inserted workflow prefix does NOT execute; the user can continue typing the prompt.
3. The user submits with a separate Enter press once the prompt is complete.

## Acceptance Criteria

- Selecting a workflow leaves the input buffer in an editable state containing `#<name> `.
