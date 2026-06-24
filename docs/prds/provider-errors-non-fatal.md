# PRD: Provider errors: visible, non-fatal, with parsed human-readable messages

| Field | Value |
| --- | --- |
| Status | draft |
| Scope | Provider error handling layers (`interactive-chat-prompt-turn.ts`, `interactive-coding-agent.ts`, `openai-compatible-errors.ts`) |

## Background

Provider HTTP failures (e.g., insufficient balance) surfaced as raw JSON and terminated the CLI instead of being shown as a readable error and letting the user retry.

## Goals

- Provider errors are visible but non-fatal.

## Non-Goals

- (none stated)

## Requirements

1. Provider HTTP failures (insufficient balance, 429, auth, network) surface as a visible `Error:` block.
2. The CLI stays alive after a provider error; the user can retry or change model without restarting.
3. The raw JSON error body is parsed into a human-readable message via the existing `extractReadableErrorMessage` path.

## Acceptance Criteria

- A provider error shows a readable Error block and leaves the CLI in an interactive, retryable state.
