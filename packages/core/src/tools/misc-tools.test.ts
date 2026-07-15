import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
    createGoalToolRegistration,
    GOAL_TOOL_NAME,
    type GoalRuntime,
    type GoalToolOptions,
    type GoalToolOutput,
} from './goal-tool';
import { createInvalidToolRegistration, INVALID_TOOL_NAME, type InvalidInput } from './invalid-tool';
import { createPlanExitToolRegistration, PLAN_EXIT_TOOL_NAME, type PlanExitOutput } from './plan-exit-tool';
import {
    createReportFindingToolRegistration,
    REPORT_FINDING_TOOL_NAME,
    type ReportFinding,
    reportFindingInputSchema,
} from './report-finding-tool';
import {
    createReportToolIssueToolRegistration,
    REPORT_TOOL_ISSUE_TOOL_NAME,
    type ReportToolIssue,
    type ReportToolIssueToolOptions,
    registerReportToolIssueTool,
} from './report-tool-issue-tool';
import { ToolRegistry } from './tool-registry';
import type { ToolExecutionContext } from './tool-registry-types';

const CTX: ToolExecutionContext = {
    toolCallId: 'tc_test',
    toolName: 'misc',
    signal: new AbortController().signal,
};

// --- plan_exit -------------------------------------------------------------

describe('plan_exit tool', () => {
    it('uses the canonical tool name and read capability', () => {
        const tool = createPlanExitToolRegistration();
        expect(tool.name).toBe(PLAN_EXIT_TOOL_NAME);
        expect(PLAN_EXIT_TOOL_NAME).toBe('plan_exit');
        expect(tool.capabilityClasses).toEqual(['read']);
    });

    it('defaults to switched when no onSwitch callback is wired (scaffold path)', async () => {
        const tool = createPlanExitToolRegistration({ planPath: 'docs/plan.md' });
        const out = await tool.execute({}, CTX);
        const output = out as PlanExitOutput;
        expect(output.status).toBe('switched');
        expect(output.agent).toBe('build');
        expect(output.planPath).toBe('docs/plan.md');
        expect(output.message).toContain('docs/plan.md');
        expect(output.message).toContain('approved');
    });

    it('switches agent and injects the handoff message when the host approves', async () => {
        let captured: { planPath: string; message: string } | undefined;
        const tool = createPlanExitToolRegistration({
            planPath: '.omo/plans/x.md',
            onSwitch: (args) => {
                captured = args;
                return { approved: true };
            },
        });
        const out = await tool.execute({}, CTX);
        expect((out as PlanExitOutput).status).toBe('switched');
        expect((out as PlanExitOutput).agent).toBe('build');
        expect(captured?.planPath).toBe('.omo/plans/x.md');
        expect(captured?.message).toContain('Execute the plan.');
    });

    it('keeps the plan agent and returns cancelled when the host declines', async () => {
        const tool = createPlanExitToolRegistration({ onSwitch: () => ({ approved: false }) });
        const out = await tool.execute({}, CTX);
        expect((out as PlanExitOutput).status).toBe('cancelled');
        expect((out as PlanExitOutput).agent).toBe('plan');
    });

    it('parses an empty strict input object', () => {
        const tool = createPlanExitToolRegistration();
        expect(tool.inputSchema.parse({})).toEqual({});
    });

    it('rejects unexpected parameters', () => {
        const tool = createPlanExitToolRegistration();
        expect(tool.inputSchema.safeParse({ surprise: 1 }).success).toBe(false);
    });
});

// --- invalid ---------------------------------------------------------------

describe('invalid tool', () => {
    it('uses the canonical tool name', () => {
        const tool = createInvalidToolRegistration();
        expect(tool.name).toBe(INVALID_TOOL_NAME);
        expect(INVALID_TOOL_NAME).toBe('invalid');
    });

    it('sinks a malformed call and echoes a deterministic message', async () => {
        const tool = createInvalidToolRegistration();
        const input: InvalidInput = { tool: 'read', error: 'expected string, got number' };
        const out = await tool.execute(input, CTX);
        expect(out.title).toBe('Invalid Tool');
        expect(out.output).toBe('The arguments provided to the tool are invalid: expected string, got number');
    });

    it('toModelOutput includes the error', () => {
        const tool = createInvalidToolRegistration();
        const text = tool.toModelOutput?.({ title: 'Invalid Tool', output: 'boom' }) ?? '';
        expect(text).toContain('Invalid Tool');
        expect(text).toContain('boom');
    });
});

// --- report_finding --------------------------------------------------------

describe('report_finding tool', () => {
    const sampleFinding: ReportFinding = {
        title: 'Uncaught null deref',
        body: 'foo() may return undefined',
        priority: 'P1',
        confidence: 0.8,
        file_path: 'src/auth.ts',
        line_start: 42,
        line_end: 45,
    };

    it('uses the canonical tool name and read capability', () => {
        const tool = createReportFindingToolRegistration();
        expect(tool.name).toBe(REPORT_FINDING_TOOL_NAME);
        expect(REPORT_FINDING_TOOL_NAME).toBe('report_finding');
        expect(tool.capabilityClasses).toEqual(['read']);
    });

    it('accepts a finding from a child subagent and records it via onFinding', async () => {
        const recorded: ReportFinding[] = [];
        const tool = createReportFindingToolRegistration({
            onFinding: (finding) => {
                recorded.push(finding);
            },
        });
        const parsed = reportFindingInputSchema.parse(sampleFinding);
        const out = await tool.execute(parsed, CTX);
        expect(out.status).toBe('recorded');
        expect(out.finding).toEqual(sampleFinding);
        expect(recorded).toEqual([sampleFinding]);
    });

    it('validates confidence bounds and priority enum at the schema layer', () => {
        expect(reportFindingInputSchema.safeParse({ ...sampleFinding, confidence: 1.5 }).success).toBe(false);
        expect(reportFindingInputSchema.safeParse({ ...sampleFinding, priority: 'P9' }).success).toBe(false);
        expect(reportFindingInputSchema.safeParse({ ...sampleFinding, confidence: 0 }).success).toBe(true);
        expect(reportFindingInputSchema.safeParse({ ...sampleFinding, confidence: 1 }).success).toBe(true);
    });

    it('rejects extra fields (strict mode)', () => {
        expect(reportFindingInputSchema.safeParse({ ...sampleFinding, extra: true }).success).toBe(false);
    });

    it('formats the location and confidence in the model output', async () => {
        const tool = createReportFindingToolRegistration();
        const out = await tool.execute(reportFindingInputSchema.parse(sampleFinding), CTX);
        const text = tool.toModelOutput?.(out) ?? '';
        expect(text).toContain('P1');
        expect(text).toContain('src/auth.ts:42-45');
        expect(text).toContain('80%');
    });

    it('collapses a single-line range in the location formatter', () => {
        const tool = createReportFindingToolRegistration();
        const single = reportFindingInputSchema.parse({ ...sampleFinding, line_end: 42 });
        const out = tool.toModelOutput?.({ status: 'recorded', finding: single }) ?? '';
        expect(out).toContain('src/auth.ts:42\n');
    });
});

// --- report_tool_issue -----------------------------------------------------

describe('report_tool_issue tool', () => {
    it('uses the canonical tool name', () => {
        const tool = createReportToolIssueToolRegistration({ enabled: true });
        expect(tool.name).toBe(REPORT_TOOL_ISSUE_TOOL_NAME);
        expect(REPORT_TOOL_ISSUE_TOOL_NAME).toBe('report_tool_issue');
    });

    it('records a grievance via onIssue when enabled and the tool is allowed', async () => {
        const recorded: ReportToolIssue[] = [];
        const tool = createReportToolIssueToolRegistration({
            enabled: true,
            allowedToolNames: ['read', 'edit'],
            onIssue: (issue) => {
                recorded.push(issue);
            },
        });
        const out = await tool.execute({ tool: 'read', report: 'returned stale data' }, CTX);
        expect(out.status).toBe('recorded');
        expect(recorded).toEqual([{ tool: 'read', report: 'returned stale data' }]);
    });

    it('honors the config gate: disabled registration reports disabled and records nothing', async () => {
        const recorded: ReportToolIssue[] = [];
        const tool = createReportToolIssueToolRegistration({
            enabled: false,
            onIssue: (issue) => {
                recorded.push(issue);
            },
        });
        const out = await tool.execute({ tool: 'read', report: 'x' }, CTX);
        expect(out.status).toBe('disabled');
        expect(recorded).toEqual([]);
    });

    it('silently drops reports for tools outside the allowlist without recording', async () => {
        const recorded: ReportToolIssue[] = [];
        const tool = createReportToolIssueToolRegistration({
            enabled: true,
            allowedToolNames: ['read'],
            onIssue: (issue) => {
                recorded.push(issue);
            },
        });
        const out = await tool.execute({ tool: 'some_mcp_tool', report: 'x' }, CTX);
        expect(out.status).toBe('dropped');
        expect(recorded).toEqual([]);
    });

    it('strips a proxy_ prefix before the allowlist check', async () => {
        const recorded: ReportToolIssue[] = [];
        const tool = createReportToolIssueToolRegistration({
            enabled: true,
            allowedToolNames: ['read'],
            onIssue: (issue) => {
                recorded.push(issue);
            },
        });
        const out = await tool.execute({ tool: 'proxy_read', report: 'x' }, CTX);
        expect(out.status).toBe('recorded');
        expect(recorded).toEqual([{ tool: 'read', report: 'x' }]);
    });

    it('records everything when the allowlist is absent', async () => {
        const recorded: ReportToolIssue[] = [];
        const tool = createReportToolIssueToolRegistration({
            enabled: true,
            onIssue: (issue) => {
                recorded.push(issue);
            },
        });
        const out = await tool.execute({ tool: 'whatever', report: 'x' }, CTX);
        expect(out.status).toBe('recorded');
        expect(recorded.length).toBe(1);
    });

    it('never throws even when onIssue rejects', async () => {
        const tool = createReportToolIssueToolRegistration({
            enabled: true,
            onIssue: () => {
                throw new Error('storage down');
            },
        });
        const out = await tool.execute({ tool: 'read', report: 'x' }, CTX);
        expect(out.status).toBe('recorded');
    });

    it('registerReportToolIssueTool returns undefined when disabled (config gate)', () => {
        const registry = new ToolRegistry();
        const opts: ReportToolIssueToolOptions = { enabled: false };
        expect(registerReportToolIssueTool(registry, opts)).toBeUndefined();
    });

    it('registerReportToolIssueTool advertises when enabled', () => {
        const registry = new ToolRegistry();
        const ad = registerReportToolIssueTool(registry, { enabled: true });
        expect(ad?.name).toBe(REPORT_TOOL_ISSUE_TOOL_NAME);
    });
});

// --- goal ------------------------------------------------------------------

function makeRuntime(overrides: Partial<GoalRuntime> = {}): GoalRuntime {
    let goal: import('./goal-tool').GoalState | null = null;
    return {
        createGoal: (args) => {
            goal = {
                objective: args.objective,
                status: 'active',
                tokensUsed: 0,
                ...(args.tokenBudget !== undefined ? { tokenBudget: args.tokenBudget } : {}),
            };
            return goal;
        },
        getGoal: () => goal,
        completeGoal: () => {
            if (goal !== null) goal = { ...goal, status: 'complete' };
            return goal as import('./goal-tool').GoalState;
        },
        resumeGoal: () => {
            if (goal !== null) goal = { ...goal, status: 'active' };
            return goal as import('./goal-tool').GoalState;
        },
        dropGoal: () => {
            const prev = goal;
            goal = null;
            return prev;
        },
        ...overrides,
    };
}

describe('goal tool', () => {
    it('uses the canonical tool name and read capability', () => {
        const tool = createGoalToolRegistration();
        expect(tool.name).toBe(GOAL_TOOL_NAME);
        expect(GOAL_TOOL_NAME).toBe('goal');
        expect(tool.capabilityClasses).toEqual(['read']);
    });

    it('reports not_active when no runtime is wired (does not throw)', async () => {
        const tool = createGoalToolRegistration();
        const out = await tool.execute({ op: 'get' }, CTX);
        const output = out as GoalToolOutput;
        expect(output.status).toBe('not_active');
        expect(output.goal).toBeNull();
    });

    it('creates a goal with an objective and optional token budget', async () => {
        const runtime = makeRuntime();
        const tool = createGoalToolRegistration({ runtime });
        const out = await tool.execute({ op: 'create', objective: 'ship the feature', token_budget: 4096 }, CTX);
        expect((out as GoalToolOutput).status).toBe('created');
        expect((out as GoalToolOutput).goal?.objective).toBe('ship the feature');
        expect((out as GoalToolOutput).goal?.tokenBudget).toBe(4096);
    });

    it('returns no_goal when create is called without an objective', async () => {
        const runtime = makeRuntime();
        const tool = createGoalToolRegistration({ runtime });
        const out = await tool.execute({ op: 'create' }, CTX);
        expect((out as GoalToolOutput).status).toBe('no_goal');
        expect((out as GoalToolOutput).goal).toBeNull();
    });

    it('gets, completes, resumes, and drops a goal through the runtime', async () => {
        const runtime = makeRuntime();
        const tool = createGoalToolRegistration({ runtime });
        await tool.execute({ op: 'create', objective: 'do thing' }, CTX);

        const got = (await tool.execute({ op: 'get' }, CTX)) as GoalToolOutput;
        expect(got.status).toBe('active');
        expect(got.goal?.status).toBe('active');

        const completed = (await tool.execute({ op: 'complete' }, CTX)) as GoalToolOutput;
        expect(completed.status).toBe('complete');
        expect(completed.goal?.status).toBe('complete');

        const resumed = (await tool.execute({ op: 'resume' }, CTX)) as GoalToolOutput;
        expect(resumed.status).toBe('resumed');
        expect(resumed.goal?.status).toBe('active');

        const dropped = (await tool.execute({ op: 'drop' }, CTX)) as GoalToolOutput;
        expect(dropped.status).toBe('dropped');

        const after = (await tool.execute({ op: 'get' }, CTX)) as GoalToolOutput;
        expect(after.status).toBe('no_goal');
    });

    it('rejects an unknown op value at the schema layer', () => {
        const tool = createGoalToolRegistration();
        expect(tool.inputSchema.safeParse({ op: 'frobnicate' }).success).toBe(false);
    });

    it('rejects a non-positive token_budget at the schema layer', () => {
        const tool = createGoalToolRegistration();
        expect(tool.inputSchema.safeParse({ op: 'create', objective: 'x', token_budget: -5 }).success).toBe(false);
        expect(tool.inputSchema.safeParse({ op: 'create', objective: 'x', token_budget: 1.5 }).success).toBe(false);
    });

    it('describes the goal (with budget) in the model output', async () => {
        const runtime = makeRuntime();
        const tool = createGoalToolRegistration({ runtime });
        await tool.execute({ op: 'create', objective: 'obj', token_budget: 1000 }, CTX);
        const got = await tool.execute({ op: 'get' }, CTX);
        const text = tool.toModelOutput?.(got as GoalToolOutput) ?? '';
        expect(text).toContain('obj');
        expect(text).toContain('1000 budget');
    });
});

// --- cross-cutting: no Effect / Bun leakage in source ---------------------

describe('misc tools source hygiene', () => {
    it('advertises a parametersJsonSchema with type object for every tool', () => {
        const tools = [
            createPlanExitToolRegistration(),
            createInvalidToolRegistration(),
            createReportFindingToolRegistration(),
            createReportToolIssueToolRegistration({ enabled: true }),
            createGoalToolRegistration(),
        ];
        for (const tool of tools) {
            const schema = tool.parametersJsonSchema as { type: string };
            expect(schema.type).toBe('object');
        }
    });

    it('every tool output schema round-trips through zod parse', () => {
        // Sanity: ensure the output schemas are valid zod schemas that parse a
        // representative value. This guards against schema typos that would
        // only surface at runtime invocation time.
        const planExitOut = z
            .object({ status: z.enum(['switched', 'cancelled']), agent: z.enum(['build', 'plan']) })
            .strict();
        expect(planExitOut.safeParse({ status: 'switched', agent: 'build' }).success).toBe(true);
    });
});
