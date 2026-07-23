import type { Client } from '@libsql/client';
import type { AgentDefinition } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openLocalLibsqlDb } from '../db/local-libsql-db';
import type { ChildSpawnRequest } from '../tools/task/task-tool';
import { ToolRegistry } from '../tools/tool-registry';
import type { ToolRegistration } from '../tools/tool-registry-types';
import { SqlAgentJobMirror } from './agent-job-sql-mirror';
import { AgentIndex } from './agent-registry';
import { AsyncJobManager } from './async-job-manager';
import { AgentLifecycleManager } from './lifecycle-manager';
import { RuntimeAgentRegistry } from './runtime-registry';
import type { TaskToolRuntimeServices } from './task-tool-runtime';
import { ConcreteTaskToolRuntime } from './task-tool-runtime';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Empty = Record<string, never>;
const emptySchema = z.object({}).strict();
const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDbUrl(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mctrl-task-obs-db-'));
    tempDirs.push(dir);
    return `file:${join(dir, 'session.sqlite')}`;
}

async function openObservabilityMirror(url: string): Promise<{
    readonly mirror: SqlAgentJobMirror;
    readonly client: Client;
    readonly close: () => void;
}> {
    const runtime = await openLocalLibsqlDb({ url });
    const mirror = await SqlAgentJobMirror.create(runtime);
    return {
        mirror,
        client: runtime.client,
        close: () => runtime.close(),
    };
}

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

function makeRequest(sessionId: string): ChildSpawnRequest {
    return {
        sessionId,
        prompt: 'do the thing',
        loadSkills: [],
        childPermissions: [],
        subagentType: 'child-agent',
    };
}

function buildRuntime(
    services: TaskToolRuntimeServices | undefined,
    spawnImpl: () => Promise<{ status: 'completed' | 'failed'; output: string }>,
): ConcreteTaskToolRuntime {
    const agentIndex = new AgentIndex();
    agentIndex.register(makeAgent());
    const parentToolRegistry = new ToolRegistry();
    parentToolRegistry.register(makeTool('read', ['read']));
    return new ConcreteTaskToolRuntime({
        agentIndex,
        resolveModel: (agent) => ({ providerID: 'test-provider', modelID: agent.name }),
        workspaceRoot: '/tmp/workspace',
        parentToolRegistry,
        parentAgent: {
            name: 'parent',
            description: 'Parent agent',
            systemPrompt: 'You are the parent.',
            source: 'bundled',
            spawns: '*',
        },
        spawnFn: async (context) => {
            const result = await spawnImpl();
            return { sessionId: context.sessionId, status: result.status, output: result.output };
        },
        ...(services !== undefined ? { services } : {}),
        parentSessionId: 'parent-session',
        isCliRootParent: true,
    });
}

async function queryChildObservability(client: Client, childSessionId: string) {
    const sessions = await client.execute({
        sql: 'SELECT session_id, parent_session_id, status FROM sessions WHERE session_id = ?',
        args: [childSessionId],
    });
    const relations = await client.execute({
        sql: 'SELECT parent_session_id, child_session_id, kind FROM session_relations WHERE child_session_id = ?',
        args: [childSessionId],
    });
    const agents = await client.execute({
        sql: 'SELECT agent_id, session_id, parent_agent_id, status FROM runtime_agents WHERE session_id = ?',
        args: [childSessionId],
    });
    const jobs = await client.execute({
        sql: 'SELECT child_session_id, parent_session_id, status FROM async_jobs WHERE child_session_id = ? ORDER BY queued_at, job_id',
        args: [childSessionId],
    });
    return { sessions: sessions.rows, relations: relations.rows, agents: agents.rows, jobs: jobs.rows };
}

describe('ConcreteTaskToolRuntime SQL child observability', () => {
    it('persists child sessions relations runtime_agents and jobs mid-run and after settle', async () => {
        const opened = await openObservabilityMirror(makeTempDbUrl());
        const { mirror, client } = opened;
        try {
            const runtimeRegistry = new RuntimeAgentRegistry({ mirror });
            const services: TaskToolRuntimeServices = {
                jobManager: new AsyncJobManager(4, { mirror }),
                lifecycleManager: new AgentLifecycleManager(runtimeRegistry),
                runtimeRegistry,
                mirror,
            };
            let releaseSpawn: () => void = () => undefined;
            let spawnStarted: () => void = () => undefined;
            const spawnStartedPromise = new Promise<void>((resolve) => {
                spawnStarted = resolve;
            });
            const runtime = buildRuntime(
                services,
                () =>
                    new Promise<{ status: 'completed'; output: string }>((resolve) => {
                        spawnStarted();
                        releaseSpawn = () => resolve({ status: 'completed', output: 'foreground output' });
                    }),
            );

            const foreground = runtime.runChildSession(makeRequest('sess-obs-fg'));
            await spawnStartedPromise;
            await mirror.flush();

            const midRun = await queryChildObservability(client, 'sess-obs-fg');
            expect(midRun.sessions.length).toBeGreaterThan(0);
            expect(midRun.sessions).toEqual([
                {
                    session_id: 'sess-obs-fg',
                    parent_session_id: 'parent-session',
                    status: 'running',
                },
            ]);
            expect(midRun.relations).toEqual([
                {
                    parent_session_id: 'parent-session',
                    child_session_id: 'sess-obs-fg',
                    kind: 'subagent',
                },
            ]);
            expect(midRun.agents).toEqual([
                {
                    agent_id: 'sess-obs-fg',
                    session_id: 'sess-obs-fg',
                    parent_agent_id: 'parent-session',
                    status: 'running',
                },
            ]);
            expect(midRun.jobs.length).toBeGreaterThan(0);
            expect(midRun.jobs).toEqual(
                expect.arrayContaining([
                    {
                        child_session_id: 'sess-obs-fg',
                        parent_session_id: 'parent-session',
                        status: 'running',
                    },
                ]),
            );

            releaseSpawn();
            const result = await foreground;
            await mirror.flush();
            expect(result).toEqual({
                sessionId: 'sess-obs-fg',
                status: 'completed',
                output: 'foreground output',
            });

            const afterSettle = await queryChildObservability(client, 'sess-obs-fg');
            expect(afterSettle.sessions).toEqual([
                {
                    session_id: 'sess-obs-fg',
                    parent_session_id: 'parent-session',
                    status: 'idle',
                },
            ]);
            expect(afterSettle.relations.length).toBeGreaterThan(0);
            expect(afterSettle.agents).toEqual([
                {
                    agent_id: 'sess-obs-fg',
                    session_id: 'sess-obs-fg',
                    parent_agent_id: 'parent-session',
                    status: 'idle',
                },
            ]);
            expect(afterSettle.jobs).toEqual(
                expect.arrayContaining([
                    {
                        child_session_id: 'sess-obs-fg',
                        parent_session_id: 'parent-session',
                        status: 'completed',
                    },
                ]),
            );
        } finally {
            opened.close();
        }
    });

    it('persists background child rows mid-run and after settle via async_jobs', async () => {
        const opened = await openObservabilityMirror(makeTempDbUrl());
        const { mirror, client } = opened;
        try {
            const runtimeRegistry = new RuntimeAgentRegistry({ mirror });
            const jobManager = new AsyncJobManager(1, { mirror });
            const services: TaskToolRuntimeServices = {
                jobManager,
                lifecycleManager: new AgentLifecycleManager(runtimeRegistry),
                runtimeRegistry,
                mirror,
            };
            let releaseSpawn: () => void = () => undefined;
            let spawnStarted: () => void = () => undefined;
            const spawnStartedPromise = new Promise<void>((resolve) => {
                spawnStarted = resolve;
            });
            const runtime = buildRuntime(
                services,
                () =>
                    new Promise<{ status: 'completed'; output: string }>((resolve) => {
                        spawnStarted();
                        releaseSpawn = () => resolve({ status: 'completed', output: 'background output' });
                    }),
            );

            const handle = runtime.startBackgroundSession(makeRequest('sess-obs-bg'));
            await spawnStartedPromise;
            await mirror.flush();

            const midRun = await queryChildObservability(client, 'sess-obs-bg');
            expect(midRun.sessions.length).toBeGreaterThan(0);
            expect(midRun.sessions).toEqual([
                {
                    session_id: 'sess-obs-bg',
                    parent_session_id: 'parent-session',
                    status: 'running',
                },
            ]);
            expect(midRun.relations).toEqual([
                {
                    parent_session_id: 'parent-session',
                    child_session_id: 'sess-obs-bg',
                    kind: 'subagent',
                },
            ]);
            expect(midRun.agents.length).toBeGreaterThan(0);
            expect(midRun.jobs.length).toBeGreaterThan(0);
            expect(midRun.jobs).toEqual(
                expect.arrayContaining([
                    {
                        child_session_id: 'sess-obs-bg',
                        parent_session_id: 'parent-session',
                        status: 'running',
                    },
                ]),
            );

            releaseSpawn();
            await jobManager.awaitJob(handle.backgroundId);
            await mirror.flush();

            const afterSettle = await queryChildObservability(client, 'sess-obs-bg');
            expect(afterSettle.sessions).toEqual([
                {
                    session_id: 'sess-obs-bg',
                    parent_session_id: 'parent-session',
                    status: 'idle',
                },
            ]);
            expect(afterSettle.jobs).toEqual(
                expect.arrayContaining([
                    {
                        child_session_id: 'sess-obs-bg',
                        parent_session_id: 'parent-session',
                        status: 'completed',
                    },
                ]),
            );
        } finally {
            opened.close();
        }
    });

    it('marks failed child sessions failed on terminal settle', async () => {
        const opened = await openObservabilityMirror(makeTempDbUrl());
        const { mirror, client } = opened;
        try {
            const runtimeRegistry = new RuntimeAgentRegistry({ mirror });
            const services: TaskToolRuntimeServices = {
                jobManager: new AsyncJobManager(4, { mirror }),
                lifecycleManager: new AgentLifecycleManager(runtimeRegistry),
                runtimeRegistry,
                mirror,
            };
            const runtime = buildRuntime(services, async () => ({
                status: 'failed',
                output: 'child boom',
            }));

            const result = await runtime.runChildSession(makeRequest('sess-obs-fail'));
            await mirror.flush();

            expect(result.status).toBe('failed');
            const afterSettle = await queryChildObservability(client, 'sess-obs-fail');
            expect(afterSettle.sessions).toEqual([
                {
                    session_id: 'sess-obs-fail',
                    parent_session_id: 'parent-session',
                    status: 'failed',
                },
            ]);
            expect(afterSettle.agents).toEqual([
                {
                    agent_id: 'sess-obs-fail',
                    session_id: 'sess-obs-fail',
                    parent_agent_id: 'parent-session',
                    status: 'failed',
                },
            ]);
            expect(afterSettle.jobs).toEqual(
                expect.arrayContaining([
                    {
                        child_session_id: 'sess-obs-fail',
                        parent_session_id: 'parent-session',
                        status: 'failed',
                    },
                ]),
            );
        } finally {
            opened.close();
        }
    });

    it('remains a no-op without SQL services', async () => {
        const runtime = buildRuntime(undefined, async () => ({
            status: 'completed',
            output: 'pure test',
        }));
        const result = await runtime.runChildSession(makeRequest('sess-obs-pure'));
        expect(result).toEqual({
            sessionId: 'sess-obs-pure',
            status: 'completed',
            output: 'pure test',
        });
    });
});
