import {
    AgentLifecycleManager,
    AsyncJobManager,
    RuntimeAgentRegistry,
    type TaskToolRuntimeServices,
} from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInteractiveToolRegistry } from './interactive-coding-tools';
import {
    fakeBroker,
    noLspServers,
    throwingResolver,
    toolOptions,
    trustedProjectTrustStore,
} from './interactive-coding-tools-test-support';
import { createNonInteractiveToolRegistry } from './noninteractive-tool-registry';
import { closeProductionToolRegistry, type ProductionToolRegistry } from './production-tool-registry';
import { createBufferedChatOutput } from './run-agent-chat-test-support';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('default parent job tool registration', () => {
    const tempRoots: string[] = [];
    const registries: ProductionToolRegistry[] = [];

    afterEach(async () => {
        await Promise.all(registries.map((registry) => closeProductionToolRegistry(registry)));
        registries.length = 0;
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('advertises job when a production root receives session-owned runtime services', async () => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);
        const services = createTaskRuntimeServices();

        // When
        const production = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowPermission,
            services,
            projectTrustStore: trustedProjectTrustStore,
            lspServerManagerDeps: noLspServers,
        });
        registries.push(production);

        // Then
        expect(advertisedNames(production)).toContain('job');
    });

    it('omits job when a production root has no runtime services', async () => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);

        // When
        const production = await createProductionRegistry(workspaceRoot);
        registries.push(production);

        // Then
        expect(advertisedNames(production)).not.toContain('job');
    });

    it('registers interactive task then job from the same runtime services', async () => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);
        const services = createTaskRuntimeServices();
        const output = createBufferedChatOutput();

        // When
        const production = await createInteractiveToolRegistry(
            { ...toolOptions(output.output, workspaceRoot, throwingResolver), services },
            fakeBroker(),
        );
        registries.push(production);

        // Then
        expect(advertisedNames(production).slice(-2)).toEqual(['task', 'job']);
    });

    it('lists jobs owned by the supplied manager through the production registry', async () => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);
        const services = createTaskRuntimeServices();
        const handle = services.jobManager.startJob({
            sessionId: 'session_job_list',
            execute: async () => ({ status: 'completed', output: 'listed' }),
        });
        await services.jobManager.awaitJob(handle.jobId);
        const production = await createProductionRegistry(workspaceRoot, services);
        registries.push(production);

        // When
        const settlement = await invokeJob(production, { action: 'list' });

        // Then
        expect(settlement.structuredOutput).toMatchObject({
            action: 'list',
            status: 'completed',
            jobs: [{ job_id: handle.jobId, session_id: 'session_job_list', status: 'completed' }],
        });
    });

    it('waits for a job owned by the supplied manager through the production registry', async () => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);
        const services = createTaskRuntimeServices();
        const handle = services.jobManager.startJob({
            sessionId: 'session_job_wait',
            execute: async () => ({ status: 'completed', output: 'waited' }),
        });
        const production = await createProductionRegistry(workspaceRoot, services);
        registries.push(production);

        // When
        const settlement = await invokeJob(production, { action: 'wait', job_id: handle.jobId });

        // Then
        expect(settlement.structuredOutput).toMatchObject({
            action: 'wait',
            job_id: handle.jobId,
            status: 'completed',
            output: 'waited',
        });
    });

    it('cancels a job owned by the supplied manager through the production registry', async () => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);
        const services = createTaskRuntimeServices();
        const handle = services.jobManager.startJob({
            sessionId: 'session_job_cancel',
            execute: (signal) =>
                new Promise((resolve) => {
                    signal.addEventListener(
                        'abort',
                        () => resolve({ status: 'completed', output: 'cancelled by signal' }),
                        { once: true },
                    );
                }),
        });
        const production = await createProductionRegistry(workspaceRoot, services);
        registries.push(production);

        // When
        const settlement = await invokeJob(production, { action: 'cancel', job_id: handle.jobId });
        await services.jobManager.drain();

        // Then
        expect(settlement.structuredOutput).toMatchObject({
            action: 'cancel',
            job_id: handle.jobId,
            status: 'cancelled',
        });
        expect(handle.status).toBe('cancelled');
    });

    it.each([
        { label: 'missing', argumentsJson: JSON.stringify({ action: 'wait' }) },
        { label: 'malformed', argumentsJson: JSON.stringify({ action: 'cancel', job_id: 42 }) },
    ])('rejects a $label job_id at the production registry schema boundary', async ({ argumentsJson }) => {
        // Given
        const workspaceRoot = await prepareWorkspace(tempRoots);
        const services = createTaskRuntimeServices();
        const production = await createProductionRegistry(workspaceRoot, services);
        registries.push(production);

        // When
        const settlement = await invokeJobJson(production, argumentsJson);

        // Then
        expect(settlement.result).toMatchObject({
            status: 'failed',
            error: { code: 'schema_invalid', retryable: true },
        });
    });
});

function createTaskRuntimeServices(): TaskToolRuntimeServices {
    const runtimeRegistry = new RuntimeAgentRegistry();
    return {
        jobManager: new AsyncJobManager(),
        lifecycleManager: new AgentLifecycleManager(runtimeRegistry),
        runtimeRegistry,
    };
}

const allowPermission = async (request: { readonly id: string }) => ({
    requestId: request.id,
    status: 'allow' as const,
    reason: 'job registration test',
});

function advertisedNames(production: ProductionToolRegistry): readonly string[] {
    return production.registry.advertise().map((advertisement) => advertisement.name);
}

async function createProductionRegistry(
    workspaceRoot: string,
    services?: TaskToolRuntimeServices,
): Promise<ProductionToolRegistry> {
    return createNonInteractiveToolRegistry({
        workspaceRoot,
        requestPermission: allowPermission,
        ...(services !== undefined ? { services } : {}),
        projectTrustStore: trustedProjectTrustStore,
        lspServerManagerDeps: noLspServers,
    });
}

async function invokeJob(production: ProductionToolRegistry, input: Readonly<Record<string, unknown>>) {
    return invokeJobJson(production, JSON.stringify(input));
}

async function invokeJobJson(production: ProductionToolRegistry, argumentsJson: string) {
    const advertisement = production.registry.advertise().find((candidate) => candidate.name === 'job');
    if (advertisement === undefined) throw new TypeError('job was not advertised');
    return production.registry.invoke({
        toolCallId: 'job_registration_test',
        toolName: 'job',
        advertisedVersion: advertisement.version,
        argumentsJson,
    });
}

async function prepareWorkspace(tempRoots: string[]): Promise<string> {
    const configRoot = await mkdtemp(join(tmpdir(), 'mctrl-job-tools-config-'));
    const dataRoot = await mkdtemp(join(tmpdir(), 'mctrl-job-tools-data-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-job-tools-workspace-'));
    tempRoots.push(configRoot, dataRoot, workspaceRoot);
    vi.stubEnv('MCTRL_CONFIG_DIR', configRoot);
    vi.stubEnv('MCTRL_DATA_DIR', dataRoot);
    vi.stubEnv('EXA_API_KEY', '');
    vi.stubEnv('PARALLEL_API_KEY', '');
    return workspaceRoot;
}
