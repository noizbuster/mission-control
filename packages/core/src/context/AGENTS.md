<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-30T00:00:00+09:00 | Updated: 2026-07-30T00:00:00+09:00 -->

# context

## Purpose

System-prompt assembly, project-instruction discovery, conversation compaction, context packing, and system-context epoch/source tracking. Owns the trusted-policy-first prompt layout that defends against prompt injection from project instruction files.

## Key Files

| File | Description |
|------|-------------|
| `system-prompt.ts` | `assembleSystemPrompt`, `DEFAULT_CODING_AGENT_PERSONA`, `renderSkills` → `<available_skills>` XML |
| `project-context-messages.ts` | Trust-aware `formatProjectContext` for AGENTS.md/CLAUDE.md resources |
| `project-resource-loader.ts` | Discover/load project instruction resources |
| `compaction.ts` | `ConversationSummary` + `compactConversation` for `/compact` |
| `context-packer.ts` | `packContext({messages, priorSummary})` — bounded token budget, preserves recent tail |
| `token-count.ts` | Token estimation helpers for packing |
| `mid-conversation-message.ts` | Mid-conversation system/context message injection |
| `system-context-source.ts` | System context source registry / baseline rendering |
| `system-context-epoch-store.ts` | Epoch store for system-context invalidation |

## Subdirectories

_None._

## For AI Agents

### Working In This Directory

- **Trust order (inviolable):** persona → env → tools → guidelines → `<available_skills>` XML → project instructions (DATA, last) → append.
- Trusted policy binds first; untrusted project instructions are framed as reference DATA, never as override commands.
- `renderSkills` emits canonical `<available_skills>` XML — never `# Skills` markdown.
- `SystemPromptEnvironment`: cwd, workspaceRoot, gitEnabled, platform, date, modelId.
- `guideline` on `ToolRegistration` must be `.optional()` with **no** `.default()` — hash stability.
- Project instructions reuse `formatProjectContext` — one injection format only.
- Default persona is provider-agnostic; per-family templates may override via `persona`.

### Testing Requirements

- `system-prompt.test.ts` — XML block rendering, no-skills omits block, XML escaping
- `project-context-messages.test.ts`, `project-trust-resource-loader.test.ts`
- `system-context-source.test.ts`, `system-context-epoch-store.test.ts`
- `context-packer.test.ts`
- End-to-end prompt wiring: `../behavior/nodes/llm-actor/llm-actor-node-runner.test.ts`
- Focused: `pnpm exec vitest run packages/core/src/context/<file>.test.ts`

### Common Patterns

- Skills metadata (name + description + optional location) only in system prompt; bodies load on demand via `skill` tool (`../tools/skill-tool.ts`).
- Compaction produces a `ConversationSummary` that `packContext` can prepend while keeping the recent message tail verbatim.
- Epoch store lets callers invalidate/rebuild baseline system context when sources change.

## Dependencies

### Internal

- `../util/escape-xml.ts` — XML escaping for skill/project blocks
- `../skills/` — skill metadata types consumed at assembly boundary
- `../tools/` — tool snippets/guidelines from registrations

### External

- None beyond workspace TypeScript runtime

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
