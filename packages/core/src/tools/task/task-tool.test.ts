import type { PolicyEffectRuleSet } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import type { ToolExecutionContext } from '../tool-registry-types.js';
import { BUILTIN_CATEGORIES, getCategory } from './category-catalog.js';
import {
    type ChildSpawnRequest,
    type CreateFullParityTaskToolOptions,
    createFullParityTaskToolRegistration,
    type TaskToolRuntime,
    taskToolInputSchema,
} from './task-tool.js';

// --- Mock runtime ----------------------------------------------------------

interface MockCall {
    readonly kind: 'run' | 'background' | 'resume' | 'exists';
    readonly request?: ChildSpawnRequest;
    readonly sessionId?: string;
}

function createMockRuntime(existingSessionIds: ReadonlySet<string> = new Set(['ses_existing'])): {
    readonly runtime: TaskToolRuntime;
    readonly calls: MockCall[];
} {
    const calls: MockCall[] = [];
    let sessionCounter = 0;
    let bgCounter = 0;
    const runtime: TaskToolRuntime = {
        runChildSession: async (request) => {
            calls.push({ kind: 'run', request });
            return { sessionId: request.sessionId, status: 'completed', output: 'child output' };
        },
        startBackgroundSession: (request) => {
            calls.push({ kind: 'background', request });
            bgCounter += 1;
            return { sessionId: request.sessionId, backgroundId: `bg_${bgCounter}` };
        },
        resumeChildSession: async (sessionId, request) => {
            calls.push({ kind: 'resume', sessionId, request });
            return { sessionId, status: 'completed', output: 'resumed output' };
        },
        sessionExists: (sessionId) => {
            calls.push({ kind: 'exists', sessionId });
            return existingSessionIds.has(sessionId);
        },
        generateSessionId: () => {
            sessionCounter += 1;
            return `ses_mock_${sessionCounter}`;
        },
    };
    return { runtime, calls };
}

function buildTool(options?: Partial<CreateFullParityTaskToolOptions>) {
    const mock = createMockRuntime();
    const tool = createFullParityTaskToolRegistration({
        runtime: mock.runtime,
        ...options,
    });
    return { tool, mock };
}

const CTX: ToolExecutionContext = {
    toolCallId: 'tc_test',
    toolName: 'task',
    signal: new AbortController().signal,
};

function params(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { prompt: 'do the thing', load_skills: [], ...overrides };
}

// --- Tests -----------------------------------------------------------------

describe('task tool — category routing', () => {
    it('spawns a child with the deep category (sonnet model, full tools, no allowlist)', async () => {
        const { tool, mock } = buildTool();
        await tool.execute(taskToolInputSchema.parse(params({ category: 'deep' })), CTX);
        const call = mock.calls.find((c) => c.kind === 'run');
        expect(call).toBeDefined();
        const request = call?.request;
        expect(request?.category?.id).toBe('deep');
        expect(request?.category?.model).toBe('sonnet');
        expect(request?.category?.tools).toBeUndefined();
    });

    it('spawns a read-only child for explore (deny write/edit/bash/patch, tool allowlist)', async () => {
        const { tool, mock } = buildTool();
        await tool.execute(taskToolInputSchema.parse(params({ category: 'explore' })), CTX);
        const request = mock.calls[0]?.request;
        expect(request?.category?.id).toBe('explore');
        expect(request?.category?.tools).toEqual(['read', 'ls', 'grep', 'find', 'glob']);
        const denyEffects =
            request?.category?.permissions.filter((r) => r.effect === 'deny').map((r) => r.action) ?? [];
        expect(denyEffects).toContain('write');
        expect(denyEffects).toContain('edit');
        expect(denyEffects).toContain('bash');
        expect(denyEffects).toContain('patch');
    });

    it('defaults to deep when neither category nor subagent_type is given', async () => {
        const { tool, mock } = buildTool();
        await tool.execute(taskToolInputSchema.parse(params()), CTX);
        expect(mock.calls[0]?.request?.category?.id).toBe('deep');
    });

    it('resolves subagent_type matching a category name to that category', async () => {
        const { tool, mock } = buildTool();
        await tool.execute(taskToolInputSchema.parse(params({ subagent_type: 'oracle' })), CTX);
        const request = mock.calls[0]?.request;
        expect(request?.category?.id).toBe('oracle');
        expect(request?.subagentType).toBe('oracle');
    });

    it('passes through unknown subagent_type without a category', async () => {
        const { tool, mock } = buildTool();
        await tool.execute(taskToolInputSchema.parse(params({ subagent_type: 'custom-agent' })), CTX);
        const request = mock.calls[0]?.request;
        expect(request?.category).toBeUndefined();
        expect(request?.subagentType).toBe('custom-agent');
    });

    it('rejects an unknown category id', async () => {
        const { tool } = buildTool();
        await expect(tool.execute(taskToolInputSchema.parse(params({ category: 'nonexistent' })), CTX)).rejects.toThrow(
            /unknown category: nonexistent/,
        );
    });
});

describe('task tool — validation', () => {
    it('rejects category and subagent_type provided together (schema-level)', () => {
        const result = taskToolInputSchema.safeParse(params({ category: 'deep', subagent_type: 'explore' }));
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues[0]?.message).toMatch(/not both/);
        }
    });

    it('accepts load_skills as an array of skill ids', () => {
        const parsed = taskToolInputSchema.parse(params({ category: 'deep', load_skills: ['frontend', 'git-master'] }));
        expect(parsed.load_skills).toEqual(['frontend', 'git-master']);
    });

    it('defaults load_skills to an empty array', () => {
        const parsed = taskToolInputSchema.parse({ prompt: 'hi', category: 'deep' });
        expect(parsed.load_skills).toEqual([]);
    });
});

describe('task tool — session resume', () => {
    it('resumes an existing session via task_id', async () => {
        const { tool, mock } = buildTool();
        const result = await tool.execute(taskToolInputSchema.parse(params({ task_id: 'ses_existing' })), CTX);
        expect(mock.calls.some((c) => c.kind === 'resume' && c.sessionId === 'ses_existing')).toBe(true);
        expect(result.status).toBe('completed');
        expect(result.output).toBe('resumed output');
    });

    it('throws when task_id does not exist', async () => {
        const { tool } = buildTool();
        await expect(tool.execute(taskToolInputSchema.parse(params({ task_id: 'ses_missing' })), CTX)).rejects.toThrow(
            /session not found: ses_missing/,
        );
    });
});

describe('task tool — background execution', () => {
    it('returns a bg_ id and running status when run_in_background is true', async () => {
        const { tool, mock } = buildTool();
        const result = await tool.execute(
            taskToolInputSchema.parse(params({ category: 'explore', run_in_background: true })),
            CTX,
        );
        expect(result.status).toBe('running');
        expect(result.backgroundId).toMatch(/^bg_/);
        expect(mock.calls.some((c) => c.kind === 'background')).toBe(true);
        expect(mock.calls.some((c) => c.kind === 'run')).toBe(false);
    });
});

describe('task tool — nested task denial', () => {
    it('child permissions always include the nested-subagent deny rule', async () => {
        const { tool, mock } = buildTool();
        await tool.execute(taskToolInputSchema.parse(params({ category: 'deep' })), CTX);
        const request = mock.calls[0]?.request;
        const nestedDeny = request?.childPermissions.find((r) => r.action === 'subagent' && r.effect === 'deny');
        expect(nestedDeny).toBeDefined();
        expect(nestedDeny?.resource).toBe('**');
    });

    it('child permissions include nested-subagent deny even with parent denies', async () => {
        const parentRules: PolicyEffectRuleSet = {
            rules: [{ action: 'write', resource: '**', effect: 'deny' }],
        };
        const { tool, mock } = buildTool({ parentAgentRules: parentRules });
        await tool.execute(taskToolInputSchema.parse(params({ category: 'quick' })), CTX);
        const perms = mock.calls[0]?.request?.childPermissions ?? [];
        expect(perms.some((r) => r.action === 'subagent' && r.effect === 'deny')).toBe(true);
        // Parent deny forwarded
        expect(perms.some((r) => r.action === 'write' && r.effect === 'deny')).toBe(true);
    });
});

describe('category catalog', () => {
    it('quick has minimal tools and sonnet model', () => {
        const quick = getCategory('quick');
        expect(quick).toBeDefined();
        expect(quick?.model).toBe('sonnet');
        expect(quick?.tools).toEqual(['read', 'ls', 'grep', 'find', 'glob', 'todowrite']);
    });

    it('ultrabrain has opus model and full tool access', () => {
        const ultrabrain = getCategory('ultrabrain');
        expect(ultrabrain).toBeDefined();
        expect(ultrabrain?.model).toBe('opus');
        expect(ultrabrain?.tools).toBeUndefined();
        expect(ultrabrain?.permissions.some((r) => r.effect === 'allow')).toBe(true);
    });

    it('metis can write to .omo/plans/ and .omo/notepads/ but deny elsewhere', () => {
        const metis = getCategory('metis');
        expect(metis).toBeDefined();
        const allows = metis?.permissions.filter((r) => r.effect === 'allow') ?? [];
        const allowResources = allows.map((r) => r.resource);
        expect(allowResources).toContain('.omo/plans/**');
        expect(allowResources).toContain('.omo/notepads/**');
        const denies = metis?.permissions.filter((r) => r.effect === 'deny') ?? [];
        expect(denies.some((r) => r.action === 'write' && r.resource === '**')).toBe(true);
    });

    it('all 9 built-in categories are present in the map', () => {
        const expected = [
            'quick',
            'deep',
            'ultrabrain',
            'visual-engineering',
            'explore',
            'oracle',
            'librarian',
            'metis',
            'momus',
        ];
        for (const id of expected) {
            expect(BUILTIN_CATEGORIES.has(id)).toBe(true);
        }
    });

    it('librarian includes webfetch in its tool allowlist', () => {
        const librarian = getCategory('librarian');
        expect(librarian?.tools).toContain('webfetch');
    });
});
