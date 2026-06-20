# Context Agent Guide

## Overview

`packages/core/src/context` owns system-prompt assembly, project-instruction discovery, conversation compaction, and context packing.

## Where To Look

| Task | Location | Notes |
| --- | --- | --- |
| System prompt | `system-prompt.ts` | `assembleSystemPrompt({persona, env, toolSnippets, guidelines, skills, resources, append})`. Trust ordering: persona → env → tools → guidelines → `<available_skills>` XML → project instructions (DATA, last). |
| Persona | `system-prompt.ts:DEFAULT_CODING_AGENT_PERSONA` | "You are a coding agent… ALWAYS use tools… NEVER ask the user to paste." Prompt-injection defense. |
| Project instructions | `project-context-messages.ts` | Trust-aware `loadProjectResources` + `formatProjectContext` for AGENTS.md/CLAUDE.md. |
| Compaction | `compaction.ts` | `ConversationSummary` type + `compactConversation` logic for `/compact`. |
| Context packing | `context-packer.ts` | `packContext({messages, priorSummary})` — bounded token budget, preserves recent tail verbatim. |

## Conventions

- Trusted policy (persona + tools + guidelines + skills) is established FIRST in the prompt; untrusted project instructions come LAST framed as DATA.
- `renderSkills` emits canonical `<available_skills>` XML (NOT `# Skills` markdown).
- `SystemPromptEnvironment` carries cwd, workspaceRoot, gitEnabled, platform, date, modelId.
- `guideline` on `ToolRegistration` must be `.optional()` with NO `.default()` — hash stability.

## Tests

- `system-prompt.test.ts`: XML block rendering, no-skills-omits-block, XML escaping.
- `llm-actor-node-runner.test.ts`: guidelines + skills wired into the assembled prompt end-to-end.

## Anti-Patterns

- Do NOT change the trust ordering (trusted policy first, untrusted DATA last).
- Do NOT keep the old `# Skills` markdown rendering — use `<available_skills>` XML.
- Do NOT add `.default()` to `guideline` — it breaks tool version hashes.
