import type { AgentDefinition } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ChildSpawnRequest } from '../tools/task/task-tool.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import type { ToolRegistration } from '../tools/tool-registry-types.js';
import { AgentIndex } from './agent-registry.js';
import { AsyncJobManager } from './async-job-manager.js';
import { AgentLifecycleManager } from './lifecycle-manager.js';
import { RuntimeAgentRegistry } from './runtime-registry.js';
import type { TaskToolRuntimeServices } from './task-tool-runtime.js';
import { ConcreteTaskToolRuntime } from './task-tool-runtime.js';

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

function makeAgent(): AgentDefinition {
    return {
        name: 'child-agent',
        description: 'Child test agent',
        systemPrompt: 'You are a child agent.',
        source: 'bundled',
    };
}

function makeParentAgent(): AgentDefinition {
    return {
        name: 'parent',
        description: 'Parent agent',
        systemPrompt: 'You are the parent.',
        source: 'bundled',
    };
}

function makeRequest(sessionId: string): ChildSpawnRequest {
    return {
        sessionId,
        prompt: 'do the thing',
        loadSkills: [],
        childPermissions: [],
        subagentType: 'child-agent',
    };
}

function makeServices(): TaskToolRuntimeServices {
    const runtimeRegistry = new RuntimeAgentRegistry();
    return {
        jobManager: new AsyncJobManager(4),
        lifecycleManager: new AgentLifecycleManager(runtimeRegistry),
        runtimeRegistry,
    };
}

function buildRuntimeWithServices(
    services: TaskToolRuntimeServices,
    spawnImpl: (sessionId: string) => Promise<{ status: 'completed' | 'failed'; output: string }>,
): ConcreteTaskToolRuntime {
    const child = makeAgent();
    const parent = makeParentAgent();
    const agentIndex = new AgentIndex();
    agentIndex.register(child);

    const parentRegistry = new ToolRegistry();
    parentRegistry.register(makeTool('read', ['read']));
    parentRegistry.register(makeTool('task', ['subagent']));

    return new ConcreteTaskToolRuntime({
        agentIndex,
        resolveModel: (agent) => ({ providerID: 'test-provider', modelID: agent.name }),
        workspaceRoot: '/tmp/workspace',
        parentToolRegistry: parentRegistry,
        parentAgent: parent,
        spawnFn: async (context) => {
            const result = await spawnImpl(context.sessionId);
            return { sessionId: context.sessionId, status: result.status, output: result.output };
        },
        services,
        parentSessionId: 'parent-session',
    });
}

function buildRuntimeWithoutServices(): ConcreteTaskToolRuntime {
    const child = makeAgent();
    const parent = makeParentAgent();
    const agentIndex = new AgentIndex();
    agentIndex.register(child);

    const parentRegistry = new ToolRegistry();
    parentRegistry.register(makeTool('read', ['read']));

    return new ConcreteTaskToolRuntime({
        agentIndex,
        resolveModel: (agent) => ({ providerID: 'test-provider', modelID: agent.name }),
        workspaceRoot: '/tmp/workspace',
        parentToolRegistry: parentRegistry,
        parentAgent: parent,
    });
}

describe('ConcreteTaskToolRuntime.startBackgroundSession', () => {
    describe('with injected services', () => {
        it('returns a handle with sessionId and backgroundId instead of throwing', () => {
            const services = makeServices();
            const runtime = buildRuntimeWithServices(services, async () => ({
                status: 'completed',
                output: 'done',
            }));

            const handle = runtime.startBackgroundSession(makeRequest('sess-bg-1'));

            expect(handle.sessionId).toBe('sess-bg-1');
            expect(handle.backgroundId).toMatch(/^job_\d+_[0-9a-f]{8}$/);
        });

        it('runs the spawn function through the AsyncJobManager and reaches completed', async () => {
            const services = makeServices();
            const runtime = buildRuntimeWithServices(services, async () => ({
                status: 'completed',
                output: 'child finished',
            }));

            const handle = runtime.startBackgroundSession(makeRequest('sess-bg-2'));
            const settled = await services.jobManager.awaitJob(handle.backgroundId);

            expect(settled.status).toBe('completed');
            expect(settled.result?.output).toBe('child finished');
        });

        it('registers the child as a running ref in the runtime registry', () => {
            const services = makeServices();
            const runtime = buildRuntimeWithServices(services, async () => ({
                status: 'completed',
                output: 'done',
            }));

            runtime.startBackgroundSession(makeRequest('sess-bg-3'));

            const ref = services.runtimeRegistry.lookup('sess-bg-3');
            expect(ref).toBeDefined();
            expect(ref?.status).toBe('running');
            expect(ref?.kind).toBe('sub');
        });

        it('surfaces child-agent failures through job state instead of swallowing them', async () => {
            const services = makeServices();
            const runtime = buildRuntimeWithServices(services, async () => {
                throw new Error('child exploded');
            });

            const handle = runtime.startBackgroundSession(makeRequest('sess-bg-4'));
            const settled = await services.jobManager.awaitJob(handle.backgroundId);

            expect(settled.status).toBe('failed');
            expect(settled.error).toBe('child exploded');
        });

        it('transitions the ref to aborted when the spawn throws', async () => {
            const services = makeServices();
            const runtime = buildRuntimeWithServices(services, async () => {
                throw new Error('boom');
            });

            runtime.startBackgroundSession(makeRequest('sess-bg-5'));
            await services.jobManager.awaitJob(
                services.jobManager.listJobs().find((j) => j.sessionId === 'sess-bg-5')?.jobId ?? '',
            );

            const ref = services.runtimeRegistry.lookup('sess-bg-5');
            expect(ref?.status).toBe('aborted');
        });

        it('transitions the ref to idle after a successful completion', async () => {
            const services = makeServices();
            const runtime = buildRuntimeWithServices(services, async () => ({
                status: 'completed',
                output: 'ok',
            }));

            runtime.startBackgroundSession(makeRequest('sess-bg-6'));
            const job = services.jobManager.listJobs().find((j) => j.sessionId === 'sess-bg-6');
            await services.jobManager.awaitJob(job?.jobId ?? '');

            const ref = services.runtimeRegistry.lookup('sess-bg-6');
            expect(ref?.status).toBe('idle');
        });

        it('runs multiple background sessions concurrently without cross-contamination', async () => {
            const services = makeServices();
            const runtime = buildRuntimeWithServices(services, async (sessionId) => ({
                status: 'completed',
                output: `output-for-${sessionId}`,
            }));

            const handle1 = runtime.startBackgroundSession(makeRequest('sess-concurrent-1'));
            const handle2 = runtime.startBackgroundSession(makeRequest('sess-concurrent-2'));

            expect(handle1.backgroundId).not.toBe(handle2.backgroundId);
            expect(handle1.sessionId).toBe('sess-concurrent-1');
            expect(handle2.sessionId).toBe('sess-concurrent-2');

            const [settled1, settled2] = await Promise.all([
                services.jobManager.awaitJob(handle1.backgroundId),
                services.jobManager.awaitJob(handle2.backgroundId),
            ]);

            expect(settled1.result?.output).toBe('output-for-sess-concurrent-1');
            expect(settled2.result?.output).toBe('output-for-sess-concurrent-2');
            expect(services.runtimeRegistry.lookup('sess-concurrent-1')?.status).toBe('idle');
            expect(services.runtimeRegistry.lookup('sess-concurrent-2')?.status).toBe('idle');
        });

        it('tracks sequential background sessions independently', async () => {
            const services = makeServices();
            const runtime = buildRuntimeWithServices(services, async () => ({
                status: 'completed',
                output: 'done',
            }));

            const first = runtime.startBackgroundSession(makeRequest('sess-seq-1'));
            await services.jobManager.awaitJob(first.backgroundId);
            expect(services.runtimeRegistry.lookup('sess-seq-1')?.status).toBe('idle');

            const second = runtime.startBackgroundSession(makeRequest('sess-seq-2'));
            await services.jobManager.awaitJob(second.backgroundId);
            expect(services.runtimeRegistry.lookup('sess-seq-2')?.status).toBe('idle');

            expect(services.runtimeRegistry.lookup('sess-seq-1')?.status).toBe('idle');
        });

        it('transitions the ref to aborted when the spawn returns a failed status without throwing', async () => {
            const services = makeServices();
            const runtime = buildRuntimeWithServices(services, async () => ({
                status: 'failed',
                output: 'child reported failure',
            }));

            const handle = runtime.startBackgroundSession(makeRequest('sess-result-fail'));
            const settled = await services.jobManager.awaitJob(handle.backgroundId);

            expect(settled.status).toBe('failed');
            expect(settled.result?.output).toBe('child reported failure');
            expect(settled.error).toBeUndefined();
            expect(services.runtimeRegistry.lookup('sess-result-fail')?.status).toBe('aborted');
        });

        it('marks the job handle as cancelled when the job manager cancels a running job', async () => {
            const services = makeServices();
            let releaseSpawn: () => void = () => undefined;
            const runtime = buildRuntimeWithServices(
                services,
                () =>
                    new Promise<{ status: 'completed'; output: string }>((resolve) => {
                        releaseSpawn = () => resolve({ status: 'completed', output: 'late' });
                    }),
            );

            const handle = runtime.startBackgroundSession(makeRequest('sess-cancel-run'));
            services.jobManager.cancelJob(handle.backgroundId);
            const settled = await services.jobManager.awaitJob(handle.backgroundId);

            expect(settled.status).toBe('cancelled');
            releaseSpawn();
        });
    });

    describe('without injected services', () => {
        it('throws not-yet-implemented (backward compatibility)', () => {
            const runtime = buildRuntimeWithoutServices();

            expect(() => runtime.startBackgroundSession(makeRequest('sess-no-svc'))).toThrow(/not yet implemented/);
        });

        it('does not register anything in a runtime registry', () => {
            const runtime = buildRuntimeWithoutServices();

            expect(() => runtime.startBackgroundSession(makeRequest('sess-no-svc-2'))).toThrow();

            expect(runtime.sessionExists('sess-no-svc-2')).toBe(false);
        });
    });
});
