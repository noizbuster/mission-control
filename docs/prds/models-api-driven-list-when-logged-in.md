# PRD: Models command: prefer live API list, expose comparison, hide verbose markers by default

| Field | Value |
| --- | --- |
| Status | draft |
| Scope | `mctrl models` provider list resolution, model discovery (`model-discovery.ts`) |

## Background

When authenticated, the hardcoded catalog preset was winning over the provider API list, hiding models the provider actually offers. Verbose `authenticated` / `executable` markers were always shown, adding noise.

## Goals

- Live API list wins by default when authenticated.
- Side-by-side comparison of API list vs preset is available.
- Verbose markers hidden by default.

## Non-Goals

- (none stated)

## Requirements

1. When authenticated, the provider API model list is shown as the default surface.
2. The provider-fetched list and the catalog preset are both visible for comparison.
3. Verbose markers `authenticated` and `executable` are hidden by default.
4. When a model is not executable, it is flagged in parentheses (rather than always-on markers).

## Acceptance Criteria

- With credentials set, `mctrl models` output is anchored on the API list.
- Both lists are visible for comparison on demand.
- Default output contains no `authenticated` / `executable` labels unless the model is non-executable.
