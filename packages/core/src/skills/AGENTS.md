<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# skills

## Purpose

`SKILL.md` discovery (multi-scope, first-wins) and metadata parsing. Pure data loading — discovery + frontmatter. The on-demand `skill` tool lives in `../tools/skill-tool.ts`. Interactive chat loads skills via `$name [args]` in `apps/cli` (dollar-prefix only; slash never expands to skill). Skill bodies are instruction DATA, never file-edit tools or executable code.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Barrel: `discoverSkills`, `Skill`, `SkillMetadataSchema`, parse helpers |
| `skill-loader.ts` | `discoverSkills({workspaceRoot})`, `parseSkillFrontmatter`, scope scan + denylist |
| `skill-metadata.ts` | `SkillMetadataSchema` (Zod): name `a-z0-9-`, optional description, `disableModelInvocation` |
| `loader.test.ts` | Discovery/frontmatter/denylist/symlink/size/injection tests |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- SKILL.md bodies are DATA — never `eval` / `import` / `require`.
- Do **not** load from `temp/ref-repos/**` — automated-discovery denylist (including dedicated guard).
- First-wins scope priority: **global-user → project-mctrl → project-agents**.
- Malformed frontmatter → skip with diagnostic, no throw.
- Size bound 64KB (`DEFAULT_MAX_SKILL_FILE_BYTES`); count bound via `DEFAULT_MAX_SKILLS`.
- Symlink lstat defense — reject escapes outside allowed roots.
- Do not eager-inject skill bodies into the system prompt; metadata only via `../context` `<available_skills>` XML; bodies on demand via `skill` tool.
- Mirrors discovery patterns in `../agents/agent-loader.ts` and `../workflows/`.

### Testing Requirements

- `loader.test.ts` — valid/invalid frontmatter, first-wins, denylist, symlink escape, size bound, prompt-injection inertness
- Focused: `pnpm exec vitest run packages/core/src/skills/loader.test.ts`

### Common Patterns

- Frontmatter between `---` fences + markdown body; parsed with `yaml` package.
- `SkillSourceInfo` / `SkillScope` track provenance for diagnostics and prompt location tags.
- `resolveUserConfigDir` + `skillsConfigDirEnvKey` for user-global scope resolution.

## Dependencies

### Internal

- Re-exported from `packages/core/src/index.ts`
- Consumers: `../context/system-prompt.ts` (metadata XML), `../tools/skill-tool.ts` (body load), `apps/cli` (`$name` expansion)

### External

- `yaml` — frontmatter parsing
- `zod` — `SkillMetadataSchema`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
