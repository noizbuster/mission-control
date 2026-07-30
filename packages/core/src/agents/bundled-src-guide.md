<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# bundled-src

## Purpose

Editable source markdown for the twelve bundled agent templates. Each file is YAML frontmatter + system-prompt body. The generator compiles these into `../bundled/*.md.ts`.

## Key Files

| File | Description |
|------|-------------|
| `architect.md` | Architect agent — design/structure focus; network ON category |
| `deep.md` | Deep research agent; network ON |
| `designer.md` | Designer agent; network ON |
| `executor.md` | Executor / implementation agent |
| `explore.md` | Read-only explore agent; network OFF |
| `librarian.md` | Docs/web lookup agent; network ON (preferred external route) |
| `oracle.md` | High-judgment oracle agent; network ON |
| `planner.md` | Planner — must declare `pathPolicies` deny write/edit/patch/bash outside `.mc/plans/**` and `.mc/notepads/**` |
| `quick.md` | Fast lightweight agent; network OFF |
| `reasoner.md` | Reasoning-focused agent; network ON |
| `reviewer.md` | Code review agent; network OFF |
| `writer.md` | Writing-focused agent |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- Edit these `.md` files, then regenerate: `node scripts/generate-bundled-agents.mjs` (or project-documented npm script).
- Frontmatter must satisfy `AgentDefinitionSchema` (`name`, tools, pathPolicies, etc.).
- Body-only directives are soft; path enforcement requires explicit `pathPolicies` (especially `planner`).
- Category/name alignment drives child network allowlist (`CHILD_NETWORK_ALLOWED_CATEGORIES` in `../child-graph-spawn.ts`).
- Keep names stable — discovery and spawn allowlists key on `name`.

### Testing Requirements

- Covered by `../bundled/bundled-agents.test.ts` after generation
- Parser edge cases: `../agent-parser.test.ts`

### Common Patterns

- Standard skill/agent frontmatter fences (`---`).
- Tools may be CSV string, array, or object map — parser normalizes all three.

## Dependencies

### Internal

- `../bundled/` — generated output
- `../agent-parser.ts` — validation contract
- `@mission-control/protocol` — `AgentDefinition` schema

### External

- None

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
