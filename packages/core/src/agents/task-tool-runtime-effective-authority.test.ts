import type { AgentDefinition } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../tools/tool-registry';
import { ToolExecutionError } from '../tools/tool-registry-types';
import { AgentIndex } from './agent-registry';
import type { ModelPattern } from './model-resolver';
import { createSqlTaskRuntimeServices, type SqlTaskRuntimeServices } from './sql-task-runtime-services';
import { ConcreteTaskToolRuntime } from './task-tool-runtime';
import {
    allowAllChildPermissions,
    makePermissionAgent,
    makePermissionRequest,
    makePermissionTool,
} from './task-tool-runtime-permissions-test-support';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];
const servicesToClose: SqlTaskRuntimeServices[] = [];

type ExecutionCounter = { value: number };

type AuthorityRuntimeInput = {
    readonly services: SqlTaskRuntimeServices;
    readonly agent: AgentDefinition;
    readonly model: ModelPattern;
    readonly providerExecutions: ExecutionCounter;
};

type ParkedChildFixture = {
    readonly services: SqlTaskRuntimeServices;
    readonly request: ReturnType<typeof makePermissionRequest>;
};

function buildAuthorityRuntime(input: AuthorityRuntimeInput): ConcreteTaskToolRuntime {
    const agentIndex = new AgentIndex();
    agentIndex.register(input.agent);
    const toolExecutions = { value: 0 };
    const parentToolRegistry = new ToolRegistry();
    parentToolRegistry.register(makePermissionTool('repo.read', ['read'], toolExecutions));
    parentToolRegistry.register(makePermissionTool('task', ['subagent'], toolExecutions));

    return new ConcreteTaskToolRuntime({
        agentIndex,
        resolveModel: () => input.model,
        workspaceRoot: '/tmp/workspace',
        parentToolRegistry,
        parentAgent: makePermissionAgent({ name: 'parent-agent', spawns: '*' }),
        spawnFn: async (context) => {
            input.providerExecutions.value += 1;
            return { sessionId: context.sessionId, status: 'completed', output: 'complete' };
        },
        services: input.services,
        parentSessionId: 'parent-session',
    });
}

async function createParkedChild(agent: AgentDefinition, model: ModelPattern): Promise<ParkedChildFixture> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-child-authority-'));
    tempDirs.push(dataDir);
    const initialServices = await createSqlTaskRuntimeServices(dataDir, { recoverActiveJobs: false });
    servicesToClose.push(initialServices);
    const initialProviderExecutions = { value: 0 };
    const runtime = buildAuthorityRuntime({
        services: initialServices,
        agent,
        model,
        providerExecutions: initialProviderExecutions,
    });
    const request = makePermissionRequest(allowAllChildPermissions);

    await runtime.runChildSession(request);
    expect(initialProviderExecutions.value).toBe(1);
    initialServices.lifecycleManager.adopt(request.sessionId, { idleTtlMs: 0 });
    await initialServices.lifecycleManager.park(request.sessionId);
    await initialServices.flush();
    await initialServices.close();

    const reopenedServices = await createSqlTaskRuntimeServices(dataDir, { recoverActiveJobs: false });
    servicesToClose.push(reopenedServices);
    expect(reopenedServices.runtimeRegistry.lookup(request.sessionId)?.status).toBe('parked');
    return { services: reopenedServices, request };
}

async function expectAuthorityRejection(
    operation: () => Promise<unknown>,
    providerExecutions: ExecutionCounter,
): Promise<void> {
    const outcome = await operation().then(
        () => ({ rejected: false as const }),
        (error: unknown) => ({ rejected: true as const, error }),
    );
    expect(outcome.rejected).toBe(true);
    if (outcome.rejected) {
        expect(outcome.error).toBeInstanceOf(ToolExecutionError);
        if (outcome.error instanceof ToolExecutionError) {
            expect(outcome.error.error.code).toBe('tool_failed');
            expect(outcome.error.message).toMatch(/authority/);
        }
    }
    expect(providerExecutions.value).toBe(0);
}

afterEach(async () => {
    for (const services of servicesToClose.splice(0)) {
        await services.close();
    }
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ConcreteTaskToolRuntime effective resumed-child authority', () => {
    it('resumes a SQL-rehydrated child when effective identity is byte-equivalent', async () => {
        const agent = makePermissionAgent({ systemPrompt: 'Original child authority body.' });
        const model = { providerID: 'provider-a', modelID: 'model-a', variantID: 'variant-a' };
        const fixture = await createParkedChild(agent, model);
        const providerExecutions = { value: 0 };
        const runtime = buildAuthorityRuntime({
            services: fixture.services,
            agent: { ...agent },
            model: { ...model },
            providerExecutions,
        });

        const result = await runtime.resumeChildSession(fixture.request.sessionId, fixture.request);
        const persisted = await fixture.services.mirror.client.execute({
            sql:
                "SELECT json_extract(metadata_json, '$.authorityFingerprint') AS authority_fingerprint, " +
                'instr(metadata_json, ?) AS prompt_position FROM runtime_agents WHERE agent_id = ?',
            args: [agent.systemPrompt, fixture.request.sessionId],
        });

        expect(result.status).toBe('completed');
        expect(providerExecutions.value).toBe(1);
        expect(persisted.rows).toEqual([
            {
                authority_fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
                prompt_position: 0,
            },
        ]);
    });

    it('rejects a SQL-rehydrated resume when the same agent name has a changed body', async () => {
        const originalAgent = makePermissionAgent({ systemPrompt: 'Original child authority body.' });
        const model = { providerID: 'provider-a', modelID: 'model-a', variantID: 'variant-a' };
        const fixture = await createParkedChild(originalAgent, model);
        const providerExecutions = { value: 0 };
        const runtime = buildAuthorityRuntime({
            services: fixture.services,
            agent: makePermissionAgent({ systemPrompt: 'Mutated child authority body.' }),
            model,
            providerExecutions,
        });

        await expectAuthorityRejection(
            () => runtime.resumeChildSession(fixture.request.sessionId, fixture.request),
            providerExecutions,
        );
    });

    it.each([
        {
            label: 'provider ID',
            model: { providerID: 'provider-b', modelID: 'model-a', variantID: 'variant-a' },
        },
        {
            label: 'model ID',
            model: { providerID: 'provider-a', modelID: 'model-b', variantID: 'variant-a' },
        },
        {
            label: 'variant ID',
            model: { providerID: 'provider-a', modelID: 'model-a', variantID: 'variant-b' },
        },
    ] satisfies readonly {
        readonly label: string;
        readonly model: ModelPattern;
    }[])('rejects a SQL-rehydrated resume when the resolved $label changes', async ({ model }) => {
        const agent = makePermissionAgent({ systemPrompt: 'Original child authority body.' });
        const originalModel = { providerID: 'provider-a', modelID: 'model-a', variantID: 'variant-a' };
        const fixture = await createParkedChild(agent, originalModel);
        const providerExecutions = { value: 0 };
        const runtime = buildAuthorityRuntime({
            services: fixture.services,
            agent,
            model,
            providerExecutions,
        });

        await expectAuthorityRejection(
            () => runtime.resumeChildSession(fixture.request.sessionId, fixture.request),
            providerExecutions,
        );
    });
});
