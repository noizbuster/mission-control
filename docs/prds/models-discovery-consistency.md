# PRD: Models command: unify lists, treat provider list as superset, render picker as popup

| Field | Value |
| --- | --- |
| Status | draft |
| Scope | `mctrl models` command output, interactive `/model` picker, model catalog resolution |
| Related plans | `.omo/plans/model-picker-input-system-fix.md`, `.omo/plans/model-provider-selection.md`, `.omo/plans/slash-skill-model-commands.md` |

## Background

The model list shown by `mctrl models` and the interactive `/model` picker disagreed. The live provider-fetched list was not treated as a superset over the catalog (it appeared as the executable subset instead). The `/model` picker also rendered inline as growing text rather than as a popup overlay in a dedicated menu area.

## Goals

- Single unified model list across `mctrl models` and `/model`.
- Provider-fetched list is the superset; preset-only entries remain visible but flagged.
- Picker renders as a popup overlay in a dedicated menu area.

## Non-Goals

- (none stated)

## Requirements

1. The model list shown by `mctrl models` and the interactive `/model` picker must agree.
2. The provider-fetched live model list is the superset; preset-only entries are flagged.
3. The `/model` picker renders as a popup overlay in a dedicated menu area, not as growing inline text in the chat region.

## Acceptance Criteria

- Diffing the two lists yields zero mismatches.
- A provider-only model (not in preset) appears in both surfaces.
- The `/model` picker does not push chat content down while open.
