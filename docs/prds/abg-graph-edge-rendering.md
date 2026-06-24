# PRD: ABG graph view: render node-to-node edges, not just the node list

| Field | Value |
| --- | --- |
| Status | draft |
| Scope | Graph tab view (`visual-graph.tsx` and helpers) |

## Background

The graph tab rendered only the node list; edges (node-to-node connections) were missing, so the graph topology was not visible.

## Goals

- Graph topology (edges) is visible in the graph tab.

## Non-Goals

- Full visual graph editor (already out of scope per AGENTS.md).

## Requirements

1. The graph tab renders edges between nodes, not just the node list.
2. The full graph topology is visible at a glance.
3. The full visual graph editor remains out of scope (per AGENTS.md).

## Acceptance Criteria

- Opening the graph tab shows both nodes and the edges connecting them.
