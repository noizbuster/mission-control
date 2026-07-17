# Tool calls, capabilities, and permissions

This document is the single source of truth for how mission-control **advertises** tools to the model, **gates** their execution, and how that differs from **skills**. Read it before changing tool registration, workflow node `capabilities`, or permission policy.

## Three layers (do not collapse them)

| Layer | What it answers | Where |
| --- | --- | --- |
| **1. Advertising** | Which tools appear in the LLM tool list / system prompt for this graph node? | `filterByCapabilities` + `expandCapabilityLabels` in `packages/core/src/behavior/nodes/llm-actor/` |
| **2. Approval / permission** | May this invocation run now (allow / ask human / deny)? | Tool `requestPermission` callbacks, `PermissionSession`, CLI permission policy, workspace trust |
| **3. Skills** | On-demand instruction text (`SKILL.md`), not executable tools | `discoverSkills`, `skill` tool, `$name` chat prefix |

A tool can be **advertised** and still **blocked at invoke time** by approval. A skill is never a substitute for `file.edit` / `file.write`.

```text
ToolRegistry.advertise()
        │
        ▼
  node.capabilities?
        │
        ├─ undefined  → advertise ALL tools (coding-agent graph default)
        ├─ []         → advertise NONE (pure structured / routing gates)
        └─ non-empty  → expand coarse labels → exact-match capabilityClasses
        │
        ▼
  Model may call tool
        │
        ▼
  Tool execute → requestPermission / trust / path guards
        │
        ├─ allow  → run
        ├─ ask    → approval.blocked / interactive prompt
        └─ deny   → tool.failed / denied
```

## Layer 1 — Advertising (OpenCode-style expand)

### Node vocabulary (coarse)

Workflow and ABG nodes declare `capabilities` as coarse labels, for example:

- `read` — explore / maturity / research nodes
- `write` — draft-plan / write-plan (and similar)
- `subagent` — delegate-worker / task fan-out
- `workflow` — route-planner
- `bash` / `exec` / `network` — when a node intentionally needs shell or network tools
- `[]` — pure gates (`outputKey` only; no tools)

### Tool vocabulary (fine)

Each tool registration sets `capabilityClasses` to **fine** strings, for example:

| Tool | Typical `capabilityClasses` |
| --- | --- |
| `glob`, `ast_grep`, `skill`, `lsp`, `todowrite` | `read` |
| `repo.read`, `read`, `ls`, `grep`, `find` | `repo.read` |
| `file.edit`, `hashline_edit`, `ast_edit` | `file.edit` |
| `file.write` | `file.write` |
| `file.patch` | `file.patch` |
| `bash.run`, `eval`, `interactive_bash` | `bash.run` |
| `command.run` | `command.run` |
| `task`, `job` | `subagent` |
| `workflow` | `workflow` |
| `webfetch`, `web_search`, many MCP tools | `network` |

### The expand map (required)

Exact match alone is wrong: a node with `write` would never see `file.edit`.

OpenCode collapses edit-class tools under one permission key before filtering. Mission-control does the same with an explicit expand table:

- Source: `packages/core/src/behavior/nodes/llm-actor/capability-expand.ts` (`CAPABILITY_EXPAND`, `expandCapabilityLabels`)
- Consumer: `filterByCapabilities` in `llm-actor-node-helpers.ts`
- Tests: `capability-expand.test.ts`

Important expansions:

| Node label | Also accepts tool classes |
| --- | --- |
| `read` | `read`, `repo.read` |
| `write` / `edit` | `write`, `edit`, `file.edit`, `file.write`, `file.patch` |
| `bash` / `exec` | `bash`, `bash.run`, `command.run`, `exec` |
| `filesystem.write` (legacy) | file mutation classes |

Rules:

1. Every declared label always includes itself (fine-grained node caps still work).
2. Unknown labels pass through unchanged (plugin/custom classes).
3. **Advertising is not security.** Expanding `write` does not auto-approve writes.

When adding a new tool, either:

- reuse an existing fine class that already expands from a coarse label, or
- add the new class to `CAPABILITY_EXPAND` for every coarse label that should unlock it, and extend `capability-expand.test.ts`.

## Layer 2 — Approval and permission (execution)

### Workspace permission store

- Schema: `PermissionKind` in `packages/protocol/src/permission-profile.ts` — `read` / `edit` / `write` / `patch` / `bash` / `network` / `subagent`
- Rules: pattern + kind + decision (`always` / `ask` / `deny` / once)
- CLI defaults: `cliPermissionRules()` in `apps/cli/src/commands/cli-permission-policy.ts` — read always; edit/write/patch/bash/network/subagent ask

This vocabulary is **not** the same as tool `capabilityClasses` or ABG `capabilities`. Do not merge the three enums.

### Per-tool invoke path

Effectful tools call `requestPermission` with an `action` (e.g. `file.edit`) and `permission` kind (e.g. `edit`). Path containment, dirty-file checks, and post-approval revalidation stay inside the tool.

### Workspace trust

Independent of capability advertising:

- Untrusted workspace: `bash.run`, `eval`, `file.edit`, `file.write` may be omitted at registry build; project `.mcp.json` stays inert.
- Trust: `/trust` and `ProjectTrustStore` under the data dir.

### Workflow policy-gate (third system)

- `PolicyEffectRule` (action / resource / effect) on modes and graphs
- Converted to `AbgPolicySpec` by `applyMode`
- Coexists with workspace `PermissionRule`; pick the layer you are editing

## Layer 3 — Skills (not tools)

- Discovery: user config `skills/`, `.mctrl/skills/`, `.agents/skills/`
- Prompt: `<available_skills>` name + description only
- Load: `skill({ name })` or `$name` — body is inert reference DATA
- Skills do **not** grant file editing; they load instructions

## Parent vs child surfaces

- Parent workflow nodes: filtered by node `capabilities` + expand map
- Child `task()` surfaces: structural drops (`task`/`job` omitted; hard drops for `subagent`/`workflow`/`network`/`team`), category and `pathPolicies`, retained workspace approval callbacks
- Child agents do not inherit parent advertising rules automatically beyond the built child registry

## Common mistakes

| Mistake | Reality |
| --- | --- |
| “file.edit is missing so install a skill” | Advertising/filter or trust/approval issue, not skills |
| Node `write` should match only tools tagged `write` | Fine tools use `file.edit` / `file.write`; expand map bridges them |
| Collapsing `PermissionKind` and `capabilityClasses` | Separate systems on purpose |
| Treating advertising as authorization | Approval broker still runs after the model proposes a call |
| Inventing skill names (`moa-plan`, `dev-browser`) | Only discovered names work; list comes from `unknown skill: … Available skills: …` |

## Reference implementations

- OpenCode: tool name + permission string; `Permission.disabled` maps `edit`/`write`/`apply_patch` → `edit` for advertising prune (`ref/opencode/packages/opencode/src/permission/index.ts`)
- OMP: tool-name allowlists + per-tool approval tier `read`/`write`/`exec` (`ref/omp/packages/coding-agent/src/tools/`)

Mission-control’s expand map is the OpenCode-aligned fix for coarse node labels vs fine tool classes.

## Code map

| Concern | Path |
| --- | --- |
| Expand map | `packages/core/src/behavior/nodes/llm-actor/capability-expand.ts` |
| Filter | `packages/core/src/behavior/nodes/llm-actor/llm-actor-node-helpers.ts` |
| LLM actor wiring | `packages/core/src/behavior/nodes/llm-actor/llm-actor-node-runner.ts` |
| Tool registry | `packages/core/src/tools/tool-registry.ts` |
| CLI tool registration | `apps/cli/src/commands/register-default-coding-tool-phases.ts` |
| CLI permission policy | `apps/cli/src/commands/cli-permission-policy.ts` |
| Workspace permission kinds | `packages/protocol/src/permission-profile.ts` |
| Skill tool | `packages/core/src/tools/skill-tool.ts` |
| Skill discovery | `packages/core/src/skills/skill-loader.ts` |
