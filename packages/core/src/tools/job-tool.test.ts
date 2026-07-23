// allow: SIZE_OK -- HEAD 271 -> current 272 pure LOC; one background-job command and child-session state-machine matrix.
import type { AgentDefinition } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentIndex } from '../agents/agent-registry';
import type { JobExecuteFn } from '../agents/async-job-manager';
import { AsyncJobManager } from '../agents/async-job-manager';
import { MAIN_AGENT_ID } from '../agents/runtime-registry';
import { ConcreteTaskToolRuntime } from '../agents/task-tool-runtime';
import { makeTaskRuntimeServices } from '../agents/task-tool-runtime-background-test-support';
import { createJobToolRegistration, JOB_TOOL_NAME, jobInputSchema } from './job-tool';
import type { ChildSpawnRequest } from './task/task-tool';
import { ToolRegistry } from './tool-registry';
import type { ToolAdvertisement, ToolRegistration } from './tool-registry-types';

type Empty = Record<string, never>;

const emptySchema = z.object({}).strict();

function makeTool(name: string, capabilityClasses: readonly string[]): ToolRegistration<Empty, Empty> {
    return {
        name,
        description: `Mock tool ${name}`,
        capabilityClasses,
        parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false },
        inputSchema: emptySchema,
        outputSchema: emptySchema,
        outputLimit: { maxModelOutputChars: 1000 },
        execute: async () => ({}),
    };
}

/** Controllable execute: the job's promise settles only when complete/fail is called. */
interface ControllableExecute {
    readonly execute: JobExecuteFn;
    readonly complete: (output: string) => void;
    readonly fail: (message: string) => void;
}

function makeControllableExecute(): ControllableExecute {
    const resolvers: Array<(result: { status: 'completed' | 'failed'; output: string }) => void> = [];
    return {
        execute: (signal: AbortSignal) =>
            new Promise((resolve, reject) => {
                resolvers.push(resolve);
                signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            }),
        complete: (output: string) => {
            const r = resolvers.shift();
            if (r !== undefined) r({ status: 'completed', output });
        },
        fail: (message: string) => {
            const r = resolvers.shift();
            if (r !== undefined) r({ status: 'failed', output: message });
        },
    };
}

function flush(): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(() => resolve(), 0);
    });
}

function buildTool(jobManager: AsyncJobManager) {
    return createJobToolRegistration({ jobManager });
}

describe('job tool — input schema', () => {
    it('accepts wait with a job_id', () => {
        const parsed = jobInputSchema.safeParse({ action: 'wait', job_id: 'job_1' });
        expect(parsed.success).toBe(true);
    });

    it('accepts list without a job_id', () => {
        const parsed = jobInputSchema.safeParse({ action: 'list' });
        expect(parsed.success).toBe(true);
    });

    it('rejects wait without a job_id', () => {
        const parsed = jobInputSchema.safeParse({ action: 'wait' });
        expect(parsed.success).toBe(false);
    });

    it('rejects cancel without a job_id', () => {
        const parsed = jobInputSchema.safeParse({ action: 'cancel' });
        expect(parsed.success).toBe(false);
    });

    it('rejects an unknown action', () => {
        const parsed = jobInputSchema.safeParse({ action: 'pause', job_id: 'job_1' });
        expect(parsed.success).toBe(false);
    });

    it('rejects `all: true` (mass-cancel anti-pattern) as an unknown key', () => {
        const parsed = jobInputSchema.safeParse({ action: 'cancel', all: true });
        expect(parsed.success).toBe(false);
    });

    it('rejects `all: true` even alongside a valid job_id', () => {
        const parsed = jobInputSchema.safeParse({ action: 'cancel', job_id: 'job_1', all: true });
        expect(parsed.success).toBe(false);
    });
});

describe('job tool — wait', () => {
    it('blocks until the job completes and returns its output', async () => {
        const manager = new AsyncJobManager(2);
        const ctrl = makeControllableExecute();
        const tool = buildTool(manager);
        const handle = manager.startJob({ sessionId: 'sess-1', execute: ctrl.execute });

        const waitPromise = tool.execute({ action: 'wait', job_id: handle.jobId }, toolContext());
        ctrl.complete('child finished');
        const result = await waitPromise;

        expect(result).toMatchObject({ action: 'wait', job_id: handle.jobId, status: 'completed' });
        expect(result.output).toBe('child finished');
    });

    it('returns failed status and error output when the job fails', async () => {
        const manager = new AsyncJobManager(2);
        const ctrl = makeControllableExecute();
        const tool = buildTool(manager);
        const handle = manager.startJob({ sessionId: 'sess-2', execute: ctrl.execute });

        const waitPromise = tool.execute({ action: 'wait', job_id: handle.jobId }, toolContext());
        ctrl.fail('something broke');
        const result = await waitPromise;

        expect(result.status).toBe('failed');
        expect(result.output).toBe('something broke');
    });

    it('returns cancelled status when the job was cancelled before wait resolves', async () => {
        const manager = new AsyncJobManager(2);
        const ctrl = makeControllableExecute();
        const tool = buildTool(manager);
        const handle = manager.startJob({ sessionId: 'sess-3', execute: ctrl.execute });

        manager.cancelJob(handle.jobId);
        const result = await tool.execute({ action: 'wait', job_id: handle.jobId }, toolContext());

        expect(result.status).toBe('cancelled');
    });

    it('returns not_found for an unknown job id (does not throw)', async () => {
        const manager = new AsyncJobManager(2);
        const tool = buildTool(manager);

        const result = await tool.execute({ action: 'wait', job_id: 'job_nonexistent' }, toolContext());

        expect(result).toMatchObject({ action: 'wait', job_id: 'job_nonexistent', status: 'not_found' });
    });
});

describe('job tool — cancel', () => {
    it('cancels a running job', async () => {
        const manager = new AsyncJobManager(2);
        const ctrl = makeControllableExecute();
        const tool = buildTool(manager);
        const handle = manager.startJob({ sessionId: 'sess-c1', execute: ctrl.execute });

        const result = await tool.execute({ action: 'cancel', job_id: handle.jobId }, toolContext());

        expect(result).toMatchObject({ action: 'cancel', job_id: handle.jobId, status: 'cancelled' });
        await flush();
        expect(manager.listJobs().find((h) => h.jobId === handle.jobId)?.status).toBe('cancelled');
    });

    it('cancels a queued job (held behind a running job)', async () => {
        const manager = new AsyncJobManager(1);
        const blocker = makeControllableExecute();
        const queued = makeControllableExecute();
        const tool = buildTool(manager);

        manager.startJob({ sessionId: 'sess-blocker', execute: blocker.execute });
        const queuedHandle = manager.startJob({ sessionId: 'sess-queued', execute: queued.execute });
        expect(queuedHandle.status).toBe('queued');

        const result = await tool.execute({ action: 'cancel', job_id: queuedHandle.jobId }, toolContext());

        expect(result.status).toBe('cancelled');
        expect(queuedHandle.status).toBe('cancelled');
    });

    it('returns not_found for an unknown job id', async () => {
        const manager = new AsyncJobManager(2);
        const tool = buildTool(manager);

        const result = await tool.execute({ action: 'cancel', job_id: 'job_ghost' }, toolContext());

        expect(result).toMatchObject({ action: 'cancel', job_id: 'job_ghost', status: 'not_found' });
    });

    it('is a no-op on an already-completed job and reports the resulting status', async () => {
        const manager = new AsyncJobManager(2);
        const tool = buildTool(manager);
        const handle = manager.startJob({
            sessionId: 'sess-done',
            execute: async () => ({ status: 'completed' as const, output: 'already done' }),
        });
        await manager.awaitJob(handle.jobId);

        const result = await tool.execute({ action: 'cancel', job_id: handle.jobId }, toolContext());

        expect(result.status).toBe('completed');
    });
});

describe('job tool — list', () => {
    it('returns every job with its id, session, and status', async () => {
        const manager = new AsyncJobManager(2);
        const tool = buildTool(manager);
        const h1 = manager.startJob({
            sessionId: 's1',
            execute: async () => ({ status: 'completed' as const, output: 'one' }),
        });
        const ctrl = makeControllableExecute();
        const h2 = manager.startJob({ sessionId: 's2', execute: ctrl.execute });
        await manager.awaitJob(h1.jobId);

        const result = await tool.execute({ action: 'list' }, toolContext());

        expect(result.action).toBe('list');
        expect(result.jobs).toBeDefined();
        const byId = new Map((result.jobs ?? []).map((j) => [j.job_id, j.status] as const));
        expect(byId.get(h1.jobId)).toBe('completed');
        expect(byId.get(h2.jobId)).toBe('running');
    });

    it('returns an empty list when there are no jobs', async () => {
        const manager = new AsyncJobManager(2);
        const tool = buildTool(manager);

        const result = await tool.execute({ action: 'list' }, toolContext());

        expect(result.jobs).toEqual([]);
    });
});

describe('job tool — model output formatting', () => {
    it('formats a completed wait result', () => {
        const tool = buildTool(new AsyncJobManager());
        const out = tool.toModelOutput?.({
            action: 'wait',
            job_id: 'job_x',
            status: 'completed',
            output: 'done',
        });
        expect(out).toContain('job_x completed');
        expect(out).toContain('done');
    });

    it('formats a failed wait result with the error', () => {
        const tool = buildTool(new AsyncJobManager());
        const out = tool.toModelOutput?.({
            action: 'wait',
            job_id: 'job_x',
            status: 'failed',
            error: 'boom',
        });
        expect(out).toContain('failed');
        expect(out).toContain('boom');
    });

    it('formats an empty list', () => {
        const tool = buildTool(new AsyncJobManager());
        const out = tool.toModelOutput?.({ action: 'list', status: 'completed', jobs: [] });
        expect(out).toContain('No background jobs');
    });
});

describe('job tool — child surface exclusion', () => {
    it('omits task and job from a terminal child tool surface', async () => {
        const child: AgentDefinition = {
            name: 'child-agent',
            description: 'child',
            systemPrompt: 'You are a child.',
            source: 'bundled',
        };
        const parent: AgentDefinition = {
            name: 'parent',
            description: 'parent',
            systemPrompt: 'You are the parent.',
            source: 'bundled',
            spawns: '*',
        };
        const agentIndex = new AgentIndex();
        agentIndex.register(child);
        const services = makeTaskRuntimeServices();
        services.runtimeRegistry.adopt({
            id: 'sess-terminal-parent',
            displayName: 'terminal parent',
            kind: 'sub',
            parentId: MAIN_AGENT_ID,
            taskDepth: 2,
            status: 'idle',
            sessionId: 'sess-terminal-parent',
        });

        const parentRegistry = new ToolRegistry();
        parentRegistry.register(makeTool('read', ['read']));
        parentRegistry.register(makeTool('task', ['subagent']));
        // Register the real job tool so the child-surface filter is exercised against it.
        parentRegistry.register(createJobToolRegistration({ jobManager: services.jobManager }));

        let capturedAds: readonly ToolAdvertisement[] = [];
        const runtime = new ConcreteTaskToolRuntime({
            agentIndex,
            resolveModel: (agent) => ({ providerID: 'test', modelID: agent.name }),
            workspaceRoot: '/tmp/ws',
            parentToolRegistry: parentRegistry,
            parentAgent: parent,
            parentSessionId: 'sess-terminal-parent',
            services,
            spawnFn: async (context) => {
                capturedAds = context.childToolRegistry.advertise();
                return { sessionId: context.sessionId, status: 'completed', output: 'ok' };
            },
        });

        const request: ChildSpawnRequest = {
            sessionId: 'sess-child',
            prompt: 'work',
            loadSkills: [],
            childPermissions: [],
            subagentType: 'child-agent',
        };
        await runtime.runChildSession(request);

        const names = capturedAds.map((a) => a.name);
        expect(services.runtimeRegistry.lookup(request.sessionId)?.taskDepth).toBe(3);
        expect(names).toContain('read');
        expect(names).toContain('yield');
        expect(names).not.toContain('task');
        expect(names).not.toContain(JOB_TOOL_NAME);
    });
});

function toolContext() {
    return { toolCallId: 'tc_job', toolName: JOB_TOOL_NAME, signal: new AbortController().signal };
}
