# Skills Agent Guide

## Overview

`packages/core/src/skills` owns `SKILL.md` discovery (multi-scope, first-wins) and metadata parsing. The on-demand `skill` tool and `/<skill-name>` slash expansion live in `apps/cli` + `packages/core/src/tools/skill-tool.ts`.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| Metadata schema | `skill-metadata.ts` | `SkillMetadataSchema` (Zod): name (lowercase a-z0-9-), optional description, disableModelInvocation. |
| Discovery + loader | `skill-loader.ts` | `discoverSkills({workspaceRoot})` — 3-scope scan (global-user → project-mctrl → project-agents), first-wins dedup, denylist (`temp/ref-repos`), symlink defense, 64KB size bound. |
| Frontmatter parser | `skill-loader.ts:parseSkillFrontmatter` | YAML frontmatter between `---` fences + markdown body. Uses `yaml` package. |
| Barrel export | `index.ts` | `discoverSkills`, `Skill`, `SkillMetadataSchema`. |

## Conventions

- SKILL.md bodies are DATA, never executed/evaluated/imported as code.
- Do NOT load skills from `temp/ref-repos/**` — the denylist reuses `read-tools-paths.ts`.
- First-wins by scope priority: global-user > project-mctrl > project-agents.
- Malformed frontmatter → skip with diagnostic, no throw.

## Tests

- `loader.test.ts` (26 tests): valid/invalid frontmatter, first-wins, denylist, symlink escape, size bound, prompt-injection inertness.

## Anti-Patterns

- Do NOT `eval`/`import`/`require` a SKILL.md body — it is reference text only.
- Do NOT eager-inject skill bodies into the system prompt — they load on demand via the `skill` tool.
