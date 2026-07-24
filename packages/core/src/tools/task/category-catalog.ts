/**
 * Built-in `task()` category definitions (Task 1.8).
 *
 * Categories are the collapsed "specialist" dimension — each presets the model,
 * permission rules, optional system-prompt addendum, and optional tool allowlist
 * for a child session spawned via the `task` tool. The catalog is pure data;
 * the `task` tool looks up a category by id and passes the definition to the
 * runtime, which resolves the model alias and builds the child tool surface.
 *
 * Permission semantics (last-match-wins, Task 1.2):
 * - Category rules narrow the child's tool surface. Parent agent path-policy
 *   denies are applied independently by `ConcreteTaskToolRuntime`.
 * - The nested-subagent deny injected by task routing is always last, so no category can
 *   re-enable nested calls via policy alone. `buildChildToolSurface` independently omits the
 *   `task` tool from the child registry.
 */
import type { PolicyEffectRule } from '@mission-control/protocol';

export interface CategoryDefinition {
    readonly id: string;
    /** Model preset alias resolved by the runtime (e.g. 'opus', 'sonnet'). */
    readonly model?: string;
    /** Additional policy-gate rules merged into the child's ruleset. */
    readonly permissions: readonly PolicyEffectRule[];
    /** Optional text appended to the child's system prompt. */
    readonly systemPromptAddendum?: string;
    /** Optional tool-name allowlist narrowing the child registry. */
    readonly tools?: readonly string[];
}

// --- Permission presets ----------------------------------------------------

const ALLOW_ALL: readonly PolicyEffectRule[] = [{ action: '*', resource: '**', effect: 'allow' }];

const READ_ONLY_DENIES: readonly PolicyEffectRule[] = [
    { action: 'write', resource: '**', effect: 'deny' },
    { action: 'edit', resource: '**', effect: 'deny' },
    { action: 'patch', resource: '**', effect: 'deny' },
    { action: 'bash', resource: '**', effect: 'deny' },
];

const PLANNING_RULES: readonly PolicyEffectRule[] = [
    ...READ_ONLY_DENIES,
    { action: 'write', resource: '.mc/plans/**', effect: 'allow' },
    { action: 'write', resource: '.mc/notepads/**', effect: 'allow' },
];

const NETWORK_TOOLS: readonly string[] = ['webfetch', 'web_search', 'mcp__*'];

// --- Built-in categories ---------------------------------------------------

const BUILTIN_CATEGORY_LIST: readonly CategoryDefinition[] = [
    {
        id: 'architect',
        model: 'mctrl/plan',
        permissions: READ_ONLY_DENIES,
        tools: ['read', 'ls', 'grep', 'find', 'glob', ...NETWORK_TOOLS],
        systemPromptAddendum:
            'You are an architecture specialist. Analyze the existing system, identify constraints and tradeoffs, and recommend an implementable design. Do not modify files.',
    },
    {
        id: 'quick',
        model: 'sonnet',
        permissions: ALLOW_ALL,
        tools: ['read', 'ls', 'grep', 'find', 'glob', 'todowrite'],
        systemPromptAddendum:
            'You are a quick task executor. Work fast, minimize tool calls, and return a concise result.',
    },
    {
        id: 'deep',
        model: 'sonnet',
        permissions: ALLOW_ALL,
        systemPromptAddendum:
            'You are a deep task executor with full tool access. Investigate thoroughly before acting.',
    },
    {
        id: 'reasoner',
        model: 'opus',
        permissions: ALLOW_ALL,
        systemPromptAddendum:
            'You are a high-reasoning task executor. Think step-by-step and consider edge cases before acting.',
    },
    {
        id: 'designer',
        model: 'sonnet',
        permissions: ALLOW_ALL,
        tools: [
            'read',
            'ls',
            'grep',
            'find',
            'file.patch',
            'file.edit',
            'file.write',
            'command.run',
            ...NETWORK_TOOLS,
        ],
        systemPromptAddendum: 'You are a frontend engineering specialist. Focus on UI, UX, and visual correctness.',
    },
    {
        id: 'explore',
        permissions: READ_ONLY_DENIES,
        tools: ['read', 'ls', 'grep', 'find', 'glob'],
        systemPromptAddendum:
            'You are a read-only codebase explorer. Map structure and report findings. Do not modify files.',
    },
    {
        id: 'oracle',
        model: 'opus',
        permissions: READ_ONLY_DENIES,
        tools: ['read', 'ls', 'grep', 'find', ...NETWORK_TOOLS],
        systemPromptAddendum:
            'You are a high-reasoning read-only consultant. Analyze deeply and provide authoritative answers.',
    },
    {
        id: 'librarian',
        permissions: READ_ONLY_DENIES,
        tools: ['read', 'ls', 'grep', 'find', ...NETWORK_TOOLS],
        systemPromptAddendum:
            'You are a documentation and reference lookup specialist. Consult docs and external references.',
    },
    {
        id: 'planner',
        permissions: PLANNING_RULES,
        tools: ['read', 'ls', 'grep', 'find', 'glob', ...NETWORK_TOOLS],
        systemPromptAddendum:
            'You are a planning specialist. Produce plans under .mc/plans/ and notes under .mc/notepads/. Read-only elsewhere. Brief external doc/API checks via webfetch, web_search, or mcp are allowed; do not sprawl into full web research. Keep plan-mode sticky and prefer local codebase evidence first.',
    },
    {
        id: 'reviewer',
        permissions: READ_ONLY_DENIES,
        tools: ['read', 'ls', 'grep', 'find'],
        systemPromptAddendum:
            'You are a review and critique specialist. Identify issues, risks, and improvements. Read-only.',
    },
];

export const BUILTIN_CATEGORIES: ReadonlyMap<string, CategoryDefinition> = new Map(
    BUILTIN_CATEGORY_LIST.map((category) => [category.id, category]),
);

export function getCategory(id: string): CategoryDefinition | undefined {
    return BUILTIN_CATEGORIES.get(id);
}
