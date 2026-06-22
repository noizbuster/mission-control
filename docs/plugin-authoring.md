# Plugin Authoring Guide

This guide shows you how to author, register, and invoke custom workflows for
Mission Control. A workflow is a named, deployable unit: an authorable
behavior graph (ABG) wrapped with discovery metadata, plus optional mode and
category presets.

Workflows are discovered from the filesystem as `*.workflow.json` or
`*.workflow.jsonc` files. You can also register them programmatically. Either
way, the same strict Zod schema validates them before they ever run.

If you want a working reference before reading further, open
[custom-example.workflow.jsonc](/examples/abg/custom-example.workflow.jsonc).
Every field documented below appears there with inline comments.

**Contents**

1. [The authoring lifecycle](#the-authoring-lifecycle)
2. [The `*.workflow.json` format](#the-workflowjson-format)
3. [The graph spec](#the-graph-spec)
4. [Categories](#categories)
5. [Modes](#modes)
6. [Validation rules](#validation-rules)
7. [Discovery](#discovery)
8. [Programmatic registration](#programmatic-registration)
9. [Invocation](#invocation)
10. [Examples](#examples)
11. [Gotchas](#gotchas)
12. [Diagnostics reference](#diagnostics-reference)

---

## The authoring lifecycle

A plugin moves through three stages.

1. **Author.** Write a `*.workflow.json` (or `.jsonc`) file. The file is a
   `WorkflowSpec`: a name, a graph, and optional modes and categories.
2. **Discover.** Drop the file into one of three discovery scopes. The loader
   finds it, strips JSONC comments, parses it, and validates it against
   `WorkflowSpecSchema`. Broken files never crash the runtime. They produce a
   diagnostic instead.
3. **Invoke.** Reference the workflow by name. Interactive chat uses
   `#name {prompt}`. Non-interactive runs use `--workflow name "prompt"`. The
   model can also self-invoke a workflow through the `workflow(name, prompt)`
   tool.

A prompt with no `#` prefix runs the built-in `default` workflow fallback.

---

## The `*.workflow.json` format

The top-level shape is `WorkflowSpecSchema`, defined in
[workflow.ts](/packages/protocol/src/workflow.ts). It is **strict**: unknown
keys are rejected.

```jsonc
{
  "name": "my-workflow",          // required, non-empty
  "description": "what it does",  // optional
  "graph": { /* AbgGraphSpec */ },// required
  "modes": [ /* Mode */ ],        // optional
  "categories": [ /* Category */ ] // optional
}
```

| Field         | Required | Type         | Notes                                                       |
| ------------- | -------- | ------------ | ----------------------------------------------------------- |
| `name`        | yes      | string       | The invocation key. Non-empty. First-wins across scopes.    |
| `description` | no       | string       | Shown in registry listings and diagnostics.                 |
| `graph`       | yes      | AbgGraphSpec | The behavior graph. See [The graph spec](#the-graph-spec).  |
| `modes`       | no       | Mode[]       | Structural overlays. See [Modes](#modes).                   |
| `categories`  | no       | Category[]   | task() presets. See [Categories](#categories).              |

The `name` is how callers reach your workflow. Pick something stable and
unique, especially if you ship into a shared global config directory, because
discovery is first-wins by name across all scopes.

---

## The graph spec

The `graph` field is an `AbgGraphSpec`, defined in
[abg.ts](/packages/protocol/src/abg.ts). It carries the nodes, edges, rules,
and policies that drive execution.

```jsonc
"graph": {
  "id": "my-workflow",
  "version": "0.1.0",              // optional
  "entryNodeId": "start",          // required, must reference a node id
  "defaults": { /* AbgGraphDefaults */ }, // optional
  "nodes": [ /* AbgNodeSpec, at least one */ ],
  "edges": [ /* AbgEdgeSpec */ ],  // defaults to []
  "rules": [ /* AbgRuleSpec */ ],  // defaults to []
  "policies": [ /* AbgPolicySpec */ ] // defaults to []
}
```

The schema runs cross-field checks on top of per-field validation. Node ids
must be unique. `entryNodeId` must point at a real node. Every edge `source`
and `target` must reference a real node. Every edge `condition` must reference
a declared rule id. Rule `activate` targets (when present) must reference a
real node. Rule ids must be unique.

### Graph defaults

`defaults` (an `AbgGraphDefaults`) applies to every node unless a node
overrides it.

```jsonc
"defaults": {
  "model": { /* AbgNodeModelOptions */ },
  "timeoutMs": 30000,   // positive integer
  "retryLimit": 2,      // non-negative integer
  "maxNodeRuns": 48     // positive integer
}
```

### Nodes

A node is an `AbgNodeSpec`.

```jsonc
{
  "id": "start",                       // required, unique
  "kind": "llm",                       // required (see kinds below)
  "label": "Human-readable label",     // optional
  "implementation": "critic",          // optional, picks a node implementation
  "model": { /* AbgNodeModelOptions */ }, // optional, overrides defaults.model
  "capabilities": ["task", "search"],  // optional, verbs the policies can gate
  "children": ["worker-a", "worker-b"],// optional, child node ids (parallel/race/join)
  "rules": ["some-rule-id"],           // optional, rule ids evaluated for this node
  "config": { "outputKey": "x.ready" } // optional, opaque string-keyed record
}
```

The `kind` field must be one of the ABG node kinds:

```
condition, action, selector, sequence, parallel, race, join, watch,
policy, statechart, actor, memory, tool, llm, human-approval
```

`config` is an opaque record with string keys and arbitrary values. The
built-in `llm` node commonly reads `systemPrompt` and `outputKey` from it, but
the schema itself does not constrain the keys.

### Edges

An edge is an `AbgEdgeSpec`.

```jsonc
{
  "id": "optional-edge-id",   // optional
  "source": "start",          // required, must be a node id
  "target": "next",           // required, must be a node id
  "condition": "some-rule",   // optional, must be a declared rule id
  "mapping": { "k": "v" },    // optional, string-to-string record
  "priority": 10              // optional, integer; lower wins on ties
}
```

An edge with no `condition` fires unconditionally. When several edges from the
same source qualify, the one with the lowest `priority` wins.

### Rules

A rule is an `AbgRuleSpec`. The `when` predicate is a discriminated union on
`kind`.

```jsonc
{
  "id": "is-ready",                // required, unique
  "description": "plan is ready",  // optional
  "when": { /* predicate */ },     // required
  "activate": "some-node"          // optional, must be a node id
}
```

Predicate kinds:

| `kind`                     | Extra fields             | Matches when                                  |
| -------------------------- | ------------------------ | --------------------------------------------- |
| `event.type.equals`        | `eventType`              | An event of that type fired.                  |
| `signal.type.equals`       | `signalType`             | A signal of that type fired.                  |
| `node.status.equals`       | `nodeId`, `status`       | The node reached that status.                 |
| `blackboard.key.exists`    | `key`                    | The blackboard key is set.                    |
| `blackboard.value.equals`  | `key`, `value`           | The blackboard key equals `value`.            |
| `policy.decision.equals`   | `decision`               | A policy resolved to that decision.           |

`signalType` must be one of: `started`, `progress`, `emit`, `select`,
`transition`, `spawn`, `cancel`, `success`, `failure`, `cancelled`,
`escalate`, `fallback`.

`status` must be one of: `idle`, `starting`, `running`, `succeeded`, `failed`,
`cancelled`, `blocked`.

`decision` must be one of: `allow`, `deny`, `requires_approval`.

### Graph-level policies

A graph policy is an `AbgPolicySpec`. This is **not** the same shape as a mode
policy rule. Graph policies gate capabilities inside the graph.

```jsonc
{
  "id": "allow-search",       // required, unique
  "capability": "search",     // required, the capability verb to gate
  "decision": "allow",        // allow | deny | requires_approval
  "reason": "why"             // optional
}
```

### Model options

Both `defaults.model` and per-node `model` use `AbgNodeModelOptions`.

```jsonc
{
  "providerID": "anthropic",          // required
  "modelID": "claude-sonnet",         // required
  "variantID": "default",             // optional
  "role": "planner",                  // optional
  "temperature": 0.2,                 // optional, 0..2
  "maxOutputTokens": 4096,            // optional, positive integer
  "timeoutMs": 30000,                 // optional, positive integer
  "budgetCents": 50,                  // optional, non-negative integer
  "fallbacks": [                      // optional
    { "providerID": "local", "modelID": "local-echo", "variantID": "x" }
  ]
}
```

The built-in `default` workflow uses `local/local-echo` so it runs offline.
Swap in a real provider when your workflow needs tool-calling behavior.

---

## Categories

A category presets the model, granted permission kinds, an optional prompt
addendum, and an optional tool allowlist for a `task()` child session. The
on-disk shape is `CategorySchema` in
[category.ts](/packages/protocol/src/category.ts). It is strict.

```jsonc
"categories": [
  {
    "id": "researcher",                       // required, non-empty
    "model": {                                // optional, AbgNodeModelOptions
      "providerID": "anthropic",
      "modelID": "claude-sonnet"
    },
    "permissions": ["read", "network"],       // required, PermissionKind[]
    "systemPromptAddendum": "Gather sources.",// optional, non-empty
    "tools": ["read", "grep", "webfetch"]     // optional, tool-name allowlist
  }
]
```

The `permissions` array holds **permission kind strings**, not policy rules.
The allowed kinds are:

```
read, edit, write, patch, bash, network, subagent
```

`tools` narrows the child's tool registry to the listed tool names. Omit it to
inherit the full built-in surface.

Note the difference between the on-disk category and the built-in runtime
categories. The runtime's built-in catalog (`quick`, `deep`, `ultrabrain`,
`visual-engineering`, `explore`, `oracle`, `librarian`, `metis`, `momus`) uses
`PolicyEffectRule[]` internally. The workflow file format uses `PermissionKind[]`.
They are two representations of the same idea. When you declare a category in a
workflow file, use the permission kind strings.

---

## Modes

A mode is a structural overlay applied at materialization time. It is not a
prompt injection. It adds a system-prompt addendum merged into llm-actor
configs, a set of policy-gate rules added to the graph, and an optional
required-tools filter.

The on-disk shape is `ModeSchema` in [mode.ts](/packages/protocol/src/mode.ts).
It is strict.

```jsonc
"modes": [
  {
    "id": "read-only",                         // required, non-empty
    "systemPromptOverlay": "Never modify files.", // optional, non-empty
    "policies": [                              // defaults to []
      { "action": "write", "resource": "**", "effect": "deny" }
    ],
    "requiredTools": ["read", "grep"]          // optional
  }
]
```

Mode policy rules use `PolicyEffectRuleSchema` from
[permission-rule.ts](/packages/protocol/src/permission-rule.ts).

```jsonc
{
  "action": "write",   // capability verb: "edit", "write", "bash", "*", ...
  "resource": "**",    // glob pattern: "src/*", "**", ".omo/plans/**"
  "effect": "deny"     // allow | deny | ask
}
```

Evaluation is last-match-wins with segment glob matching. A `*` stays within a
path segment, `**` spans segments, and `?` matches one character.

### How a mode gets bound

A workflow file declares modes by id. A Mission or Run binds to a mode using a
`ModeDeclaration` at the run level, not inside the workflow file:

```jsonc
{ "modeId": "read-only", "active": true }
```

`active` defaults to `true`, so a declaration takes effect unless you toggle it
off. The runtime can flip the flag without dropping the binding.

### Two policy systems, on purpose

Mission Control has two distinct policy shapes. They coexist by design. Do not
collapse them.

| Where              | Shape                          | Fields                                | Effect values                 |
| ------------------ | ------------------------------ | ------------------------------------- | ----------------------------- |
| Graph `policies`   | `AbgPolicySpec`                | `id`, `capability`, `decision`        | allow, deny, requires_approval |
| Mode `policies`    | `PolicyEffectRule`             | `action`, `resource`, `effect`        | allow, deny, ask              |

There is also a third, unrelated shape: the workspace permission store uses
`PermissionRuleSchema` (`permission`, `pattern`, `decision`). That lives in the
interactive permission system, not in workflows. Pick the schema that matches
the layer you are editing.

---

## Validation rules

Every discovered workflow passes through this pipeline before it is usable.

1. **JSONC strip.** The loader calls `stripJsoncComments` on the raw file
   contents. This removes `//` line comments and `/* ... */` block comments
   while preserving comment-like text inside string values.
2. **JSON parse.** The stripped text goes to `JSON.parse`.
3. **Schema validation.** The parsed value goes through
   `WorkflowSpecSchema.safeParse`. Because the schema is strict and the graph
   schema runs cross-field `superRefine` checks, structural problems (duplicate
   node ids, dangling edges, unknown rule conditions) all surface here.

The loader never throws. A failed file produces a diagnostic and is skipped.
See [Diagnostics reference](#diagnostics-reference).

**Trailing commas are not supported.** The JSONC stripper removes comments only.
After stripping, the result must be valid JSON. If you leave a trailing comma,
you get a `parse_error` diagnostic.

**Unknown keys are rejected.** Both `WorkflowSpecSchema`, `CategorySchema`,
and `ModeSchema` use `.strict()`. A typo in a field name, or a field that does
not exist in the schema, fails validation with `validation_error`.

---

## Discovery

The loader (`discoverWorkflows` in
[workflow-loader.ts](/packages/core/src/workflows/workflow-loader.ts)) walks
three scopes in priority order. Discovery is **first-wins by name**: the first
file that registers a given name wins. Later files with the same name produce a
`duplicate_name` warning and are skipped.

| Priority | Scope                                        | Who owns it              |
| -------- | -------------------------------------------- | ------------------------ |
| 1        | `<user-config-dir>/workflows/`               | Global, user-wide        |
| 2        | `<workspace>/.mctrl/workflows/`              | Project (mctrl)          |
| 3        | `<workspace>/.agents/workflows/`             | Project (agents)         |

The user config dir follows the platform convention, the same resolver used by
skill discovery.

File matching and walk rules:

- Files must end in `.workflow.json` or `.workflow.jsonc`.
- The walk recurses up to 10 levels deep.
- Symbolic links are skipped (symlink defense).
- A file larger than 64 KB (by default) is rejected with `size_exceeded`.
- More than 256 workflows (by default) stops further registration with
  `limit_reached`.

### Denylisted paths

Discovery reuses the read-only repo tool denylist. A workflow file whose path
touches any of these is skipped with a `denylisted` diagnostic:

```
temp/ref-repos, .omo/evidence, .nx, dist, build, target,
coverage, node_modules, .git
```

Directory names in the denylist (entries without a `/`) are matched as path
segments anywhere in the walk. So placing workflows under
`node_modules/.../workflows/` will not load.

---

## Programmatic registration

You can register workflows in code, bypassing the filesystem entirely. The
registry is `WorkflowRegistry` in
[workflow-registry.ts](/packages/core/src/workflows/workflow-registry.ts).

```typescript
import { WorkflowRegistry, type WorkflowSpec } from '@mission-control/core';

const registry = new WorkflowRegistry(discoveredSpecs);

const spec: WorkflowSpec = {
  name: 'inline-workflow',
  description: 'registered in code',
  graph: {
    id: 'inline',
    entryNodeId: 'only',
    nodes: [{ id: 'only', kind: 'llm' }],
    edges: [],
    rules: [],
    policies: [],
  },
};

registry.register(spec);          // add or overwrite by name
registry.lookup('inline-workflow'); // -> WorkflowSpec | undefined
registry.list();                  // -> readonly WorkflowSpec[], insertion order
registry.names();                 // -> readonly string[]
```

`register` is last-wins by name. Registering the same name again overwrites the
prior spec but preserves the original insertion-order slot, so `list()` and
`names()` stay stable.

### Category and mode registration (Task 3.11)

Programmatic registration of categories and modes is part of the Task 3.11
API surface (`registerCategory`, `registerMode`). They accept the same data
shapes the schemas define:

- a `Category` (`id`, optional `model`, required `permissions` as
  `PermissionKind[]`, optional `systemPromptAddendum`, optional `tools`).
- a `Mode` (`id`, optional `systemPromptOverlay`, `policies` as
  `PolicyEffectRule[]`, optional `requiredTools`).

When you build a `Category` or `Mode` in code, validate it with
`CategorySchema` or `ModeSchema` from `@mission-control/protocol` first. That
keeps programmatic and filesystem workflows on the same contract.

---

## Invocation

Once discovered or registered, a workflow is reachable by name through three
entry points.

**Interactive chat.** Type the workflow name prefixed with `#`:

```text
#my-workflow {summarize this repository}
```

The parser gates the prefix against discovered names using the same name regex
as skills. If the name is unknown, the line is treated as a normal prompt.

**Non-interactive run.** Pass `--workflow` (mutually exclusive with `--graph`):

```bash
mctrl run --workflow my-workflow "summarize this repository"
```

**Self-invocation by the model.** A tool-calling provider can call the
`workflow(name, prompt)` tool, which resolves the spec through the registry and
threads the graph through the same prompt-turn lifecycle as the `#name` path.

**Default fallback.** A prompt with no `#` prefix runs the built-in `default`
workflow, defined in
[default.workflow.json](/examples/abg/default.workflow.json).

---

## Examples

### Minimal workflow

The smallest valid workflow has a name and a single-node graph.

```jsonc
{
  "name": "echo",
  "graph": {
    "id": "echo",
    "entryNodeId": "reply",
    "nodes": [
      { "id": "reply", "kind": "llm" }
    ]
  }
}
```

### Workflow with a conditional branch

A graph that classifies intent and routes to two nodes.

```jsonc
{
  "name": "router",
  "graph": {
    "id": "router",
    "entryNodeId": "gate",
    "nodes": [
      {
        "id": "gate",
        "kind": "llm",
        "config": { "outputKey": "intent.classification" }
      },
      { "id": "direct", "kind": "llm" },
      { "id": "clarify", "kind": "llm" }
    ],
    "edges": [
      { "source": "gate", "target": "direct", "condition": "trivial", "priority": 10 },
      { "source": "gate", "target": "clarify", "condition": "ambiguous", "priority": 5 }
    ],
    "rules": [
      {
        "id": "trivial",
        "when": { "kind": "blackboard.value.equals", "key": "intent.classification", "value": "trivial" }
      },
      {
        "id": "ambiguous",
        "when": { "kind": "blackboard.value.equals", "key": "intent.classification", "value": "ambiguous" }
      }
    ]
  }
}
```

### Workflow with a mode

Add a read-only mode that blocks writes.

```jsonc
{
  "name": "readonly-answer",
  "graph": {
    "id": "readonly-answer",
    "entryNodeId": "answer",
    "nodes": [{ "id": "answer", "kind": "llm" }]
  },
  "modes": [
    {
      "id": "read-only",
      "systemPromptOverlay": "Never modify files. Cite your sources.",
      "policies": [
        { "action": "write", "resource": "**", "effect": "deny" }
      ]
    }
  ]
}
```

### Workflow with a category

Ship a researcher preset for `task()` delegation.

```jsonc
{
  "name": "research",
  "graph": {
    "id": "research",
    "entryNodeId": "gather",
    "nodes": [{ "id": "gather", "kind": "llm" }]
  },
  "categories": [
    {
      "id": "researcher",
      "model": { "providerID": "anthropic", "modelID": "claude-sonnet" },
      "permissions": ["read", "network"],
      "tools": ["read", "grep", "webfetch"]
    }
  ]
}
```

### Full documented example

See [custom-example.workflow.jsonc](/examples/abg/custom-example.workflow.jsonc).
It combines a graph, a mode, and a category in one file with inline JSONC
comments on every field.

---

## Gotchas

**Name collisions are silent and first-wins.** If two scopes define a workflow
with the same name, the higher-priority scope wins and the other is skipped
with a `duplicate_name` warning. There is no merge. Check the diagnostics if a
workflow you expect is missing.

**Trailing commas break parsing.** The JSONC stripper removes comments only.
`JSON.parse` still rejects trailing commas. You get a `parse_error` diagnostic
and the file is skipped.

**Unknown top-level fields are rejected.** `WorkflowSpecSchema` is strict.
Adding a field the schema does not know (for example `version` at the workflow
level, or a typo like `desription`) fails validation. Graph-level `version` is
fine because it lives under `graph`.

**Symlinks are ignored.** Discovery skips symbolic links to prevent escaping
the scope directory. Symlink your workflow files at your own risk.

**Large files are capped.** The default size limit is 64 KB. Files above it are
rejected with `size_exceeded`. Raise the limit in code by passing
`maxWorkflowFileBytes` to `discoverWorkflows`, but prefer splitting very large
graphs into reusable components.

**There is a workflow count cap.** The default is 256 workflows. Once reached,
further files are skipped with `limit_reached`.

**Denylisted directories are skipped.** Placing workflows under `node_modules`,
`dist`, `build`, `target`, `.git`, `coverage`, `.nx`, `.omo/evidence`, or
`temp/ref-repos` will not load them.

**Graph policies and mode policies are different shapes.** Graph `policies`
use `{ id, capability, decision }` with `decision` in
`allow | deny | requires_approval`. Mode `policies` use
`{ action, resource, effect }` with `effect` in `allow | deny | ask`. Mixing
them up fails validation.

**The `name` regex matters.** Invocation parses `#name` against the same
identifier rules as skills. Stick to lowercase letters, digits, and hyphens,
starting with a letter or digit, to stay safe.

---

## Diagnostics reference

The loader emits a `WorkflowDiscoveryDiagnostic` for each problem it finds.
Each carries a `workflowName`, a `severity` (`error`, `warning`, or `info`),
a `code`, a `message`, and an optional `path`.

| Code               | Severity | Meaning                                                      |
| ------------------ | -------- | ------------------------------------------------------------ |
| `validation_error` | error    | The file failed `WorkflowSpecSchema` validation.            |
| `parse_error`      | error    | The stripped content was not valid JSON (often trailing commas). |
| `read_failed`      | error    | The file could not be read from disk.                        |
| `duplicate_name`   | warning  | A workflow with this name was already registered.            |
| `limit_reached`    | warning  | The max-workflows cap was hit.                               |
| `size_exceeded`    | warning  | The file exceeded the byte limit.                            |
| `denylisted`       | warning  | The file path matched the discovery denylist.                |

When a workflow is missing, check the diagnostics stream first. The loader
collects these instead of throwing, so a broken file in one scope never blocks
discovery of the rest.
