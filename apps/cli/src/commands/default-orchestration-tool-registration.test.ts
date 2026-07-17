import type { GoalRuntime, GoalState, ReportFinding } from '@mission-control/core';
import type { MissionControlConfig } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInteractiveToolRegistry } from './interactive-coding-tools';
import {
    allowAllPermission,
    fakeBroker,
    noLspServers,
    toolOptions,
    trustedProjectTrustStore,
} from './interactive-coding-tools-test-support';
import { createNonInteractiveToolRegistry } from './noninteractive-tool-registry';
import { closeProductionToolRegistry, type ProductionToolRegistry } from './production-tool-registry';
import type { ParentMiscToolHostOptions } from './register-default-coding-tools';
import { createBufferedChatOutput } from './run-agent-chat-test-support';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MISC_TOOL_NAMES = [
    'checkpoint',
    'rewind',
    'report_tool_issue',
    'plan_exit',
    'goal',
    'debug',
    'report_finding',
] as const;

describe('default orchestration tool registration', () => {
    const tempRoots: string[] = [];
    const registries: ProductionToolRegistry[] = [];

    afterEach(async () => {
        await Promise.all(registries.map((registry) => closeProductionToolRegistry(registry)));
        registries.length = 0;
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('advertises only checkpoint and rewind by default in both production hosts', async () => {
        const workspaceRoot = await prepareWorkspace(tempRoots);

        const pair = await createProductionRegistries(workspaceRoot);
        registries.push(...pair);

        for (const production of pair) {
            expect(miscToolNames(production)).toEqual(['checkpoint', 'rewind']);
        }
    });

    it('shares one checkpoint coordinator with rewind in a production registry', async () => {
        const workspaceRoot = await prepareWorkspace(tempRoots);
        const production = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowAllPermission,
            projectTrustStore: trustedProjectTrustStore,
            lspServerManagerDeps: noLspServers,
        });
        registries.push(production);

        const checkpoint = await invokeTool(production, 'checkpoint', { goal: 'trace registration state' });
        const rewind = await invokeTool(production, 'rewind', { report: 'the coordinator is registry-local' });

        expect(checkpoint.result.status).toBe('completed');
        expect(rewind.result.status).toBe('completed');
        expect(rewind.structuredOutput).toMatchObject({
            rewound: true,
            report: 'the coordinator is registry-local',
            collapsedMessageCount: 0,
        });
    });

    it('rejects a duplicate active checkpoint in a production registry', async () => {
        const workspaceRoot = await prepareWorkspace(tempRoots);
        const production = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: allowAllPermission,
            projectTrustStore: trustedProjectTrustStore,
            lspServerManagerDeps: noLspServers,
        });
        registries.push(production);
        await invokeTool(production, 'checkpoint', { goal: 'first' });

        const duplicate = await invokeTool(production, 'checkpoint', { goal: 'second' });

        expect(duplicate.result.status).toBe('failed');
        expect(duplicate.result.error?.message).toContain('checkpoint is already active');
    });

    it('advertises debug only for the existing explicit config opt-in', async () => {
        const workspaceRoot = await prepareWorkspace(tempRoots);

        const pair = await createProductionRegistries(workspaceRoot, {}, { debug: { enabled: true } });
        registries.push(...pair);

        for (const production of pair) expect(miscToolNames(production)).toContain('debug');
    });

    it('registers callback-backed parent tools only through explicit host options', async () => {
        const workspaceRoot = await prepareWorkspace(tempRoots);
        const issueSink = vi.fn();
        const findingSink = vi.fn<(finding: ReportFinding) => void>();
        const output = createBufferedChatOutput();
        const production = await createInteractiveToolRegistry(
            {
                ...toolOptions(output.output, workspaceRoot),
                reportToolIssueSink: issueSink,
                goalRuntime,
                reportFinding: { onFinding: findingSink },
                planExit: { onSwitch: () => ({ approved: false }) },
            },
            fakeBroker(),
        );
        registries.push(production);

        const issue = await invokeTool(production, 'report_tool_issue', {
            tool: 'read',
            report: 'returned stale data',
        });
        const planExit = await invokeTool(production, 'plan_exit', {});

        expect(miscToolNames(production)).toEqual([
            'checkpoint',
            'rewind',
            'report_tool_issue',
            'plan_exit',
            'goal',
            'report_finding',
        ]);
        expect(issue.result.status).toBe('completed');
        expect(issueSink).toHaveBeenCalledWith({ tool: 'read', report: 'returned stale data' });
        expect(planExit.structuredOutput).toMatchObject({ status: 'cancelled', agent: 'plan' });
    });
});

const activeGoal: GoalState = {
    objective: 'verify Task 12',
    status: 'active',
    tokensUsed: 0,
};

const goalRuntime: GoalRuntime = {
    createGoal: (args) => ({ ...activeGoal, objective: args.objective }),
    getGoal: () => activeGoal,
    completeGoal: () => ({ ...activeGoal, status: 'complete' }),
    resumeGoal: () => activeGoal,
    dropGoal: () => activeGoal,
};

async function createProductionRegistries(
    workspaceRoot: string,
    options: ParentMiscToolHostOptions = {},
    config?: MissionControlConfig,
): Promise<readonly [ProductionToolRegistry, ProductionToolRegistry]> {
    const output = createBufferedChatOutput();
    const configOption = config === undefined ? {} : { config };
    const interactive = await createInteractiveToolRegistry(
        { ...toolOptions(output.output, workspaceRoot), ...options, ...configOption },
        fakeBroker(),
    );
    const noninteractive = await createNonInteractiveToolRegistry({
        workspaceRoot,
        requestPermission: allowAllPermission,
        projectTrustStore: trustedProjectTrustStore,
        lspServerManagerDeps: noLspServers,
        ...options,
        ...configOption,
    });
    return [interactive, noninteractive];
}

async function invokeTool(
    production: ProductionToolRegistry,
    toolName: (typeof MISC_TOOL_NAMES)[number],
    input: Readonly<Record<string, unknown>>,
) {
    const advertisement = production.registry.advertise().find((candidate) => candidate.name === toolName);
    if (advertisement === undefined) throw new TypeError(`${toolName} was not advertised`);
    return production.registry.invoke({
        toolCallId: `${toolName}_task_12`,
        toolName,
        advertisedVersion: advertisement.version,
        argumentsJson: JSON.stringify(input),
    });
}

function miscToolNames(production: ProductionToolRegistry): readonly string[] {
    return production.registry
        .advertise()
        .map((advertisement) => advertisement.name)
        .filter((name) => MISC_TOOL_NAMES.some((candidate) => candidate === name));
}

async function prepareWorkspace(tempRoots: string[]): Promise<string> {
    const configRoot = await mkdtemp(join(tmpdir(), 'mctrl-misc-tools-config-'));
    const dataRoot = await mkdtemp(join(tmpdir(), 'mctrl-misc-tools-data-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-misc-tools-workspace-'));
    tempRoots.push(configRoot, dataRoot, workspaceRoot);
    vi.stubEnv('MCTRL_CONFIG_DIR', configRoot);
    vi.stubEnv('MCTRL_DATA_DIR', dataRoot);
    for (const key of ['EXA_API_KEY', 'PARALLEL_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY']) {
        vi.stubEnv(key, '');
    }
    return workspaceRoot;
}
