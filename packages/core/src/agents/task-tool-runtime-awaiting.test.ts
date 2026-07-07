import { createClient } from '@libsql/client';
import type { AgentDefinition } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { deriveSessionLifecycle } from '../memory/session-status-derivation.js';
import { openSqliteSessionProjectionStore } from '../memory/sqlite-session-projection.js';
import type { ChildSpawnRequest } from '../tools/task/task-tool.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import type { ToolRegistration } from '../tools/tool-registry-types.js';
import { SqlAgentJobMirror } from './agent-job-sql-mirror.js';
import { AgentIndex } from './agent-registry.js';
import { AsyncJobManager } from './async-job-manager.js';
import { AgentLifecycleManager } from './lifecycle-manager.js';
import { RuntimeAgentRegistry } from './runtime-registry.js';
import type { TaskToolRuntimeServices } from './task-tool-runtime.js';
import { ConcreteTaskToolRuntime } from './task-tool-runtime.js';
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
    const dir = mkdtempSync(join(tmpdir(), 'mctrl-task-awaiting-db-'));
    tempDirs.push(dir);
    return `file:${join(dir, 'session.sqlite')}`;
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
    services: TaskToolRuntimeServices,
    spawnImpl: () => Promise<{ status: 'completed'; output: string }>,
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
        },
        spawnFn: async (context) => {
            const result = await spawnImpl();
            return { sessionId: context.sessionId, status: result.status, output: result.output };
        },
        services,
        parentSessionId: 'parent-session',
    });
}

describe('ConcreteTaskToolRuntime awaiting/subagent mirror', () => {
    it('recomputes a resolved foreground subagent wait back to running when the parent has an active run', async () => {
        const url = makeTempDbUrl();
        const publicStore = await openSqliteSessionProjectionStore({ url });
        const client = createClient({ url });
        try {
            const mirror = await SqlAgentJobMirror.create(client);
            await mirror.startSubagentWait({
                parentSessionId: 'parent-running-session',
                childSessionId: 'child-running-session',
                mode: 'sync',
            });
            await mirror.flush();
            await client.execute({
                sql:
                    'INSERT INTO mission_runs (run_id, mission_id, session_id, status, created_at, updated_at, passthrough_json) ' +
                    'VALUES (?, ?, ?, ?, ?, ?, ?)',
                args: [
                    'run_parent_active',
                    'mission_parent_active',
                    'parent-running-session',
                    'running',
                    '2026-07-06T00:00:00.000Z',
                    '2026-07-06T00:00:00.000Z',
                    '{}',
                ],
            });

            await mirror.resolveSubagentWait({
                parentSessionId: 'parent-running-session',
                childSessionId: 'child-running-session',
                status: 'completed',
                output: 'child output',
            });
            await mirror.flush();
            const parentSession = await publicStore.getSession('parent-running-session');

            expect(parentSession).toMatchObject({
                sessionId: 'parent-running-session',
                status: 'running',
            });
            expect(parentSession?.awaiting).toBeUndefined();
        } finally {
            publicStore.close();
            client.close();
        }
    });

    it('records awaiting/subagent only while a foreground child blocks the parent', async () => {
        const url = makeTempDbUrl();
        const publicStore = await openSqliteSessionProjectionStore({ url });
        const client = createClient({ url });
        try {
            const mirror = await SqlAgentJobMirror.create(client);
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

            const foreground = runtime.runChildSession(makeRequest('sess-foreground'));
            await spawnStartedPromise;
            await mirror.flush();

            const publicWhileBlocked = await publicStore.getSession('parent-session');
            const whileBlocked = deriveSessionLifecycle({
                terminalEvent: { kind: 'none' },
                activeRuns: [],
                pendingWaits: await mirror.loadPendingWaits('parent-session'),
                backgroundJobs: await mirror.loadBackgroundJobsForParent('parent-session'),
            });
            expect(whileBlocked.status).toBe('awaiting');
            if (whileBlocked.status === 'awaiting') {
                expect(whileBlocked.awaitingReason).toBe('subagent');
                expect(whileBlocked.primaryWaitId).toBe('sess-foreground');
            }
            expect(publicWhileBlocked).toMatchObject({
                sessionId: 'parent-session',
                status: 'awaiting',
                awaiting: {
                    reason: 'subagent',
                    source: {
                        jobId: 'sess-foreground',
                        childSessionId: 'sess-foreground',
                    },
                },
            });

            releaseSpawn();
            await foreground;
            await mirror.flush();
            const backgroundHandle = runtime.startBackgroundSession(makeRequest('sess-background'));
            await mirror.flush();

            const publicAfterBackground = await publicStore.getSession('parent-session');
            const afterBackground = deriveSessionLifecycle({
                terminalEvent: { kind: 'none' },
                activeRuns: [],
                pendingWaits: await mirror.loadPendingWaits('parent-session'),
                backgroundJobs: await mirror.loadBackgroundJobsForParent('parent-session'),
            });
            expect(backgroundHandle.backgroundId).toMatch(/^job_/);
            expect(afterBackground.status).toBe('idle');
            expect(publicAfterBackground).toMatchObject({
                sessionId: 'parent-session',
                status: 'idle',
            });
            expect(publicAfterBackground?.awaiting).toBeUndefined();
        } finally {
            publicStore.close();
            client.close();
        }
    });
});
