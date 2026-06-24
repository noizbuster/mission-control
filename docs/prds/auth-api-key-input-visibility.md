# PRD: Auth flow: show input progress during API key entry without revealing the value

| Field | Value |
| --- | --- |
| Status | draft |
| Scope | Auth login interactive flow (`auth-prompts.ts`) |
| Related plans | `.omo/plans/interactive-auth-logout.md` |

## Background

During interactive `auth login`, the API key entry field gave no indication of how many characters had been typed, leaving the user unsure whether input was being captured.

## Goals

- API key entry shows input progress without revealing the value.

## Non-Goals

- Displaying the raw API key in cleartext.

## Requirements

1. While entering an API key interactively, surface the number of characters typed.
2. The actual key value must remain masked (no cleartext display).

## Acceptance Criteria

- Typing into the API key field updates a visible character counter while masking the value.
