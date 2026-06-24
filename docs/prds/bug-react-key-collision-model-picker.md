# PRD: Bug: React key collision in model picker (`provider: zai-co`)

| Field | Value |
| --- | --- |
| Status | draft |
| Scope | Model picker React key construction |

## Background

The model picker emitted `Encountered two children with the same key, "provider: zai-co"`. Duplicate React keys cause React to warn and may duplicate or omit children.

## Goals

- Unique React keys in the picker.

## Non-Goals

- (none stated)

## Requirements

1. Eliminate the React warning `Encountered two children with the same key, "provider: zai-co"`.
2. Picker item keys must be unique across the entire list.
3. Keys must remain stable across re-renders for the same logical item.

## Acceptance Criteria

- No React key-collision warning appears when opening the model picker.
