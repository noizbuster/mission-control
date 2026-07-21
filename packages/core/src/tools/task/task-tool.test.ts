// allow: SIZE_OK -- HEAD 397 -> current 388 pure LOC; one task routing, batch, resume, and background lifecycle state-machine matrix.
import { beforeAll, describe, expect, it } from 'vitest';
import { discoverAgents } from '../../agents/agent-loader';
import { AgentIndex } from '../../agents/agent-registry';
import type { ToolExecutionContext } from '../tool-registry-types';
import { getCategory } from './category-catalog';
import { ToolExecutionError } from '../tool-registry-types';
import {
    classifyChildSpawnFailure,
    type ChildSpawnRequest,
    type CreateFullParityTaskToolOptions,
    createFullParityTaskToolRegistration,
    type TaskToolRuntime,
    taskToolInputSchema,
} from './task-tool';

// --- Mock runtime ----------------------------------------------------------

interface MockCall {
    readonly kind: 'run' | 'background' | 'resume' | 'exists';
    readonly request?: ChildSpawnRequest;
    readonly sessionId?: string;
}

type RunResultOverride = (
    request: ChildSpawnRequest,
) =>
    | { status: 'completed' | 'failed'; output: string; failureKind?: 'yield_missing' | 'graph_failed' | 'tool_denied' | 'aborted' }
    | Promise<{
          status: 'completed' | 'failed';
          output: string;
          failureKind?: 'yield_missing' | 'graph_failed' | 'tool_denied' | 'aborted';
      }>;

function createMockRuntime(
    existingSessionIds: ReadonlySet<string> = new Set(['ses_existing']),
    runResultOverride?: RunResultOverride,
): {
    readonly runtime: TaskToolRuntime;
    readonly calls: MockCall[];
} {
    const calls: MockCall[] = [];
    let sessionCounter = 0;
    let bgCounter = 0;
    const runtime: TaskToolRuntime = {
        runChildSession: async (request) => {
            calls.push({ kind: 'run', request });
            if (runResultOverride !== undefined) {
                return { sessionId: request.sessionId, ...(await runResultOverride(request)) };
            }
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

function buildTool(options?: Partial<CreateFullParityTaskToolOptions>, runResultOverride?: RunResultOverride) {
    const mock = createMockRuntime(new Set(['ses_existing']), runResultOverride);
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

// --- Bundled agent discovery (shared across discovery + parity tests) -------

let agentIndex: AgentIndex;

beforeAll(async () => {
    const result = await discoverAgents({ workspaceRoot: '/nonexistent', userConfigDir: '/nonexistent' });
    agentIndex = new AgentIndex(result);
});

const ALL_CATEGORY_IDS = [
    'quick',
    'deep',
    'reasoner',
    'designer',
    'explore',
    'oracle',
    'librarian',
    'planner',
    'reviewer',
] as const;

function ruleKey(rule: { readonly action: string; readonly resource: string; readonly effect: string }): string {
    return `${rule.action}|${rule.resource}|${rule.effect}`;
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

    it('threads optional title onto the child spawn request', async () => {
        const { tool, mock } = buildTool();
        await tool.execute(
            taskToolInputSchema.parse(params({ category: 'deep', title: 'Investigate auth' })),
            CTX,
        );
        expect(mock.calls[0]?.request?.title).toBe('Investigate auth');
        expect(mock.calls[0]?.request?.category?.id).toBe('deep');
    });

    it('threads batch item title onto each child spawn request', async () => {
        const { tool, mock } = buildTool();
        await tool.execute(
            taskToolInputSchema.parse({
                load_skills: [],
                tasks: [{ agent: 'explore', assignment: 'scan repo', title: 'Scan workspace' }],
            }),
            CTX,
        );
        const run = mock.calls.find((call) => call.kind === 'run');
        expect(run?.request?.title).toBe('Scan workspace');
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

describe('task tool — prompt/assignment normalize', () => {
    it('accepts both prompt and assignment; child receives assignment text', async () => {
        const { tool, mock } = buildTool();
        const parsed = taskToolInputSchema.parse({
            load_skills: [],
            category: 'deep',
            prompt: 'parent framing for the child',
            assignment: 'do the concrete assignment',
        });
        expect(parsed.assignment).toBe('do the concrete assignment');
        expect(parsed.prompt).toBeUndefined();
        expect(parsed.context).toBe('parent framing for the child');

        await tool.execute(parsed, CTX);
        const request = mock.calls[0]?.request;
        expect(request?.prompt).toBe('do the concrete assignment');
        expect(request?.parentContext).toBe('parent framing for the child');
    });

    it('leaves prompt-only input unchanged', async () => {
        const { tool, mock } = buildTool();
        const parsed = taskToolInputSchema.parse({ load_skills: [], prompt: 'prompt only work' });
        expect(parsed.prompt).toBe('prompt only work');
        expect(parsed.assignment).toBeUndefined();
        expect(parsed.context).toBeUndefined();

        await tool.execute(parsed, CTX);
        expect(mock.calls[0]?.request?.prompt).toBe('prompt only work');
        expect(mock.calls[0]?.request?.parentContext).toBeUndefined();
    });

    it('leaves assignment-only input unchanged', async () => {
        const { tool, mock } = buildTool();
        const parsed = taskToolInputSchema.parse({ load_skills: [], assignment: 'assignment only work' });
        expect(parsed.assignment).toBe('assignment only work');
        expect(parsed.prompt).toBeUndefined();
        expect(parsed.context).toBeUndefined();

        await tool.execute(parsed, CTX);
        expect(mock.calls[0]?.request?.prompt).toBe('assignment only work');
        expect(mock.calls[0]?.request?.parentContext).toBeUndefined();
    });

    it('keeps existing context when both prompt and assignment are present', () => {
        const parsed = taskToolInputSchema.parse({
            load_skills: [],
            prompt: 'discarded framing',
            assignment: 'keep assignment',
            context: 'already set parent context',
        });
        expect(parsed.assignment).toBe('keep assignment');
        expect(parsed.prompt).toBeUndefined();
        expect(parsed.context).toBe('already set parent context');
    });

    it('drops prompt without merging when it equals assignment', () => {
        const parsed = taskToolInputSchema.parse({
            load_skills: [],
            prompt: 'same text',
            assignment: 'same text',
        });
        expect(parsed.assignment).toBe('same text');
        expect(parsed.prompt).toBeUndefined();
        expect(parsed.context).toBeUndefined();
    });

    it('rejects both prompt+assignment together with tasks (batch XOR intact)', () => {
        const result = taskToolInputSchema.safeParse({
            load_skills: [],
            prompt: 'parent framing',
            assignment: 'child work',
            tasks: [{ agent: 'explore', assignment: 'batch item' }],
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues.some((issue) => issue.message.includes('either'))).toBe(true);
        }
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

describe('task tool — nested task depth gate', () => {
    it('tool-layer child permissions include nested-subagent deny (runtime may strip when depth allows)', async () => {
        const { tool, mock } = buildTool();
        await tool.execute(taskToolInputSchema.parse(params({ category: 'deep' })), CTX);
        const request = mock.calls[0]?.request;
        const nestedDeny = request?.childPermissions.find((r) => r.action === 'subagent' && r.effect === 'deny');
        expect(nestedDeny).toBeDefined();
        expect(nestedDeny?.resource).toBe('**');
    });

    it('description documents bounded nested task depth rather than a hard ban', () => {
        const { tool } = buildTool();
        expect(tool.description).toMatch(/depth 3/i);
        expect(tool.description).not.toMatch(/cannot spawn nested tasks/i);
        expect(tool.guideline).toMatch(/depth 3/i);
        expect(tool.guideline).not.toMatch(/cannot spawn nested tasks/i);
    });
});

describe('bundled agent discovery via AgentIndex', () => {
    it('all 9 built-in agent names are discoverable', () => {
        for (const id of ALL_CATEGORY_IDS) {
            expect(agentIndex.lookup(id)).toBeDefined();
        }
    });

    it('quick has minimal tools', () => {
        const quick = agentIndex.lookup('quick');
        expect(quick?.tools).toEqual(['read', 'ls', 'grep', 'find', 'glob', 'todowrite']);
    });

    it('reasoner has full tool access (no allowlist)', () => {
        const reasoner = agentIndex.lookup('reasoner');
        expect(reasoner?.tools).toBeUndefined();
    });

    it('planner pathPolicies allow .mc/plans/ and .mc/notepads/ writes, deny elsewhere', () => {
        const planner = agentIndex.lookup('planner');
        expect(planner?.pathPolicies).toBeDefined();
        const allows = planner?.pathPolicies?.filter((r) => r.effect === 'allow') ?? [];
        expect(allows.map((r) => r.resource)).toContain('.mc/plans/**');
        expect(allows.map((r) => r.resource)).toContain('.mc/notepads/**');
        const denies = planner?.pathPolicies?.filter((r) => r.effect === 'deny') ?? [];
        expect(denies.some((r) => r.action === 'write' && r.resource === '**')).toBe(true);
    });

    it('ON network categories list webfetch and web_search; OFF categories do not', () => {
        const onWithTools = ['librarian', 'oracle', 'designer', 'planner'] as const;
        const off = ['explore', 'reviewer', 'quick'] as const;
        for (const id of onWithTools) {
            const bundled = agentIndex.lookup(id);
            const catalog = getCategory(id);
            expect(bundled?.tools).toContain('webfetch');
            expect(bundled?.tools).toContain('web_search');
            expect(catalog?.tools).toContain('webfetch');
            expect(catalog?.tools).toContain('web_search');
        }
        for (const id of off) {
            const bundled = agentIndex.lookup(id);
            const catalog = getCategory(id);
            expect(bundled?.tools ?? []).not.toContain('webfetch');
            expect(bundled?.tools ?? []).not.toContain('web_search');
            expect(catalog?.tools ?? []).not.toContain('webfetch');
            expect(catalog?.tools ?? []).not.toContain('web_search');
        }
        expect(agentIndex.lookup('deep')?.tools).toBeUndefined();
        expect(agentIndex.lookup('reasoner')?.tools).toBeUndefined();
        expect(getCategory('deep')?.tools).toBeUndefined();
        expect(getCategory('reasoner')?.tools).toBeUndefined();
    });
});

describe('bundled agent parity with category catalog', () => {
    it('tools match between catalog and bundled for every category', () => {
        for (const id of ALL_CATEGORY_IDS) {
            const catalog = getCategory(id);
            const bundled = agentIndex.lookup(id);
            expect(catalog).toBeDefined();
            expect(bundled).toBeDefined();
            if (catalog?.tools === undefined) {
                expect(bundled?.tools).toBeUndefined();
            } else {
                expect(bundled?.tools ?? []).toEqual([...catalog.tools]);
            }
        }
    });

    it('catalog systemPromptAddendum is a substring of bundled systemPrompt for every category', () => {
        for (const id of ALL_CATEGORY_IDS) {
            const catalog = getCategory(id);
            const bundled = agentIndex.lookup(id);
            if (catalog?.systemPromptAddendum !== undefined) {
                expect(bundled?.systemPrompt ?? '').toContain(catalog.systemPromptAddendum);
            }
        }
    });

    it('planner bundled pathPolicies set matches catalog permissions set', () => {
        const catalog = getCategory('planner');
        const bundled = agentIndex.lookup('planner');
        const catalogKeys = (catalog?.permissions ?? []).map(ruleKey).sort();
        const bundledKeys = (bundled?.pathPolicies ?? []).map(ruleKey).sort();
        expect(bundledKeys).toEqual(catalogKeys);
    });

    it('read-only categories enforce read-only via tier and tool surface (parity with catalog READ_ONLY_DENIES)', () => {
        const readOnlyIds = ['explore', 'oracle', 'librarian', 'reviewer'] as const;
        const mutatingTools = ['file.edit', 'file.write', 'file.patch', 'command.run', 'bash.run'];
        for (const id of readOnlyIds) {
            const bundled = agentIndex.lookup(id);
            expect(bundled?.tier).toBe('read');
            for (const tool of mutatingTools) {
                expect(bundled?.tools ?? []).not.toContain(tool);
            }
        }
    });
});

describe('task tool — batch mode', () => {
    it('rejects prompt and tasks provided together (XOR at schema level)', () => {
        const result = taskToolInputSchema.safeParse(params({ tasks: [{ agent: 'explore', assignment: 'look' }] }));
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues.some((i) => i.message.includes('either'))).toBe(true);
        }
    });

    it('rejects tasks and assignment provided together (XOR at schema level)', () => {
        const result = taskToolInputSchema.safeParse({
            load_skills: [],
            assignment: 'do thing',
            tasks: [{ agent: 'explore', assignment: 'look' }],
        });
        expect(result.success).toBe(false);
    });

    it('spawns one child per task and returns a batch summary', async () => {
        const { tool, mock } = buildTool();
        const result = await tool.execute(
            taskToolInputSchema.parse({
                load_skills: [],
                tasks: [
                    { agent: 'explore', assignment: 'find a', role: 'finder-a' },
                    { agent: 'explore', assignment: 'find b', role: 'finder-b' },
                    { agent: 'librarian', assignment: 'find c', role: 'finder-c' },
                ],
            }),
            CTX,
        );
        const runCalls = mock.calls.filter((c) => c.kind === 'run');
        expect(runCalls).toHaveLength(3);
        expect(result.batch).toBeDefined();
        expect(result.batch).toHaveLength(3);
        expect(result.status).toBe('completed');
        for (const item of result.batch ?? []) {
            expect(item.status).toBe('completed');
            expect(item.sessionId).toMatch(/^ses_mock_/);
        }
        const roles = (result.batch ?? []).map((b) => b.role).sort();
        expect(roles).toEqual(['finder-a', 'finder-b', 'finder-c']);
    });

    it('returns partial results when one child fails (no throw)', async () => {
        const { tool, mock } = buildTool(undefined, (request) => {
            if (request.prompt.includes('fail-me')) {
                return { status: 'failed', output: 'boom' };
            }
            return { status: 'completed', output: 'ok' };
        });
        const result = await tool.execute(
            taskToolInputSchema.parse({
                load_skills: [],
                tasks: [
                    { agent: 'explore', assignment: 'work-1' },
                    { agent: 'explore', assignment: 'fail-me' },
                    { agent: 'explore', assignment: 'work-2' },
                ],
            }),
            CTX,
        );
        expect(result.batch).toHaveLength(3);
        const statuses = (result.batch ?? []).map((b) => b.status).sort();
        expect(statuses).toEqual(['completed', 'completed', 'failed']);
        const failedItem = (result.batch ?? []).find((b) => b.status === 'failed');
        expect(failedItem?.output).toBe('boom');
        expect(mock.calls.filter((c) => c.kind === 'run')).toHaveLength(3);
    });

    it('propagates context to every child as parentContext', async () => {
        const { tool, mock } = buildTool();
        await tool.execute(
            taskToolInputSchema.parse({
                load_skills: [],
                context: 'shared batch context for all children',
                tasks: [
                    { agent: 'explore', assignment: 'a' },
                    { agent: 'explore', assignment: 'b' },
                ],
            }),
            CTX,
        );
        const runCalls = mock.calls.filter((c) => c.kind === 'run');
        expect(runCalls).toHaveLength(2);
        for (const call of runCalls) {
            expect(call.request?.parentContext).toBe('shared batch context for all children');
        }
    });

    it('rejects an empty tasks array', () => {
        const result = taskToolInputSchema.safeParse({ load_skills: [], tasks: [] });
        expect(result.success).toBe(false);
    });

    it('accepts agent alias for single-spawn (routes like subagent_type)', async () => {
        const { tool, mock } = buildTool();
        await tool.execute(taskToolInputSchema.parse({ load_skills: [], agent: 'oracle', assignment: 'think' }), CTX);
        const request = mock.calls[0]?.request;
        expect(request?.category?.id).toBe('oracle');
        expect(request?.prompt).toBe('think');
    });

    it('rejects agent provided alongside category', () => {
        const result = taskToolInputSchema.safeParse({
            load_skills: [],
            category: 'deep',
            agent: 'oracle',
            assignment: 'x',
        });
        expect(result.success).toBe(false);
    });

    it('toModelOutput summarizes each batch item concisely', async () => {
        const { tool } = buildTool();
        const result = await tool.execute(
            taskToolInputSchema.parse({
                load_skills: [],
                tasks: [{ agent: 'explore', assignment: 'a', role: 'scout' }],
            }),
            CTX,
        );
        const summary = tool.toModelOutput?.(result);
        expect(summary).toBeDefined();
        expect(summary).toContain('scout');
        expect(summary).toContain('completed');
    });
});

describe('classifyChildSpawnFailure', () => {
    it('marks yield_missing as retryable task_yield_missing', () => {
        expect(
            classifyChildSpawnFailure({
                sessionId: 's1',
                status: 'failed',
                output: '[degraded salvage] mid work',
                failureKind: 'yield_missing',
            }),
        ).toEqual({ code: 'task_yield_missing', retryable: true });
    });

    it('marks graph_failed as non-retryable task_child_failed', () => {
        expect(
            classifyChildSpawnFailure({
                sessionId: 's1',
                status: 'failed',
                output: 'boom',
                failureKind: 'graph_failed',
            }),
        ).toEqual({ code: 'task_child_failed', retryable: false });
    });

    it('infers yield_missing from degraded salvage prefix without failureKind', () => {
        expect(
            classifyChildSpawnFailure({
                sessionId: 's1',
                status: 'failed',
                output: '[degraded salvage] leftover prose',
            }),
        ).toEqual({ code: 'task_yield_missing', retryable: true });
    });
});

describe('task tool — yield_missing settlement', () => {
    it('throws retryable task_yield_missing so parent settlement stays non-terminal', async () => {
        const { tool } = buildTool(undefined, () => ({
            status: 'failed',
            output: '[degraded salvage] still investigating',
            failureKind: 'yield_missing',
        }));
        try {
            await tool.execute(taskToolInputSchema.parse(params({ category: 'deep' })), CTX);
            expect.unreachable('expected ToolExecutionError');
        } catch (error) {
            expect(error).toBeInstanceOf(ToolExecutionError);
            if (!(error instanceof ToolExecutionError)) return;
            expect(error.error.code).toBe('task_yield_missing');
            expect(error.error.retryable).toBe(true);
        }
    });
});
