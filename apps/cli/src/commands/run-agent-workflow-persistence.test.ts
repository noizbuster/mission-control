/**
 * Noninteractive workflow Mission/Run persistence (Task 3).
 *
 * Asserts that an explicit noninteractive workflow invocation
 * (`mctrl --workflow planner "x"` and the `#planner {x}` form) materializes a
 * Mission and starts a Run under `.mc/{missions,runs}/` before the turn, then
 * transitions the Run to `completed` (success) or `failed` (provider failure)
 * when the turn settles — without changing the plain/JSON output contract, and
 * without persisting anything for a plain (non-workflow) prompt.
 */
import { listMissions, listRunsForMission } from '@mission-control/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from './run-agent';
import {
    createCompletingWorkflowModel,
    createFailingWorkflowModel,
    createWorkflowPersistenceFixture,
    firstRecord,
    removeWorkflowPersistenceFixture,
    WORKFLOW_PERSISTENCE_SPEC,
} from './run-agent-workflow-test-support';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('noninteractive workflow Mission/Run persistence', () => {
    let workspaceDir: string;
    let configDir: string;
    let dataDir: string;

    beforeEach(async () => {
        const fixture = await createWorkflowPersistenceFixture();
        workspaceDir = fixture.workspaceDir;
        configDir = fixture.configDir;
        dataDir = fixture.dataDir;
        vi.stubEnv('MCTRL_CONFIG_DIR', configDir);
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await removeWorkflowPersistenceFixture({ workspaceDir, configDir, dataDir });
    });

    it('persists a completed Mission and Run for --workflow', async () => {
        const output = await runAgent(
            {
                mode: 'plain',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
                thinking: false,
                workflowName: 'persist-demo',
                prompt: 'plan the migration',
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            },
            {
                workspaceRoot: workspaceDir,
                resolveSdkModel: () => createCompletingWorkflowModel(),
            },
        );

        // T8 streaming gate: plain mode returns '' (blocks streamed to stdout).
        expect(output).toBe('');

        const location = { mcRoot: workspaceDir, dataDir };
        const missions = await listMissions(location);
        expect(missions).toHaveLength(1);
        const mission = firstRecord(missions);
        expect(mission.workflowName).toBe('persist-demo');
        expect(mission.status).toBe('active');

        const runs = await listRunsForMission(location, mission.id);
        expect(runs).toHaveLength(1);
        const run = firstRecord(runs);
        expect(run.status).toBe('completed');
        expect(run.missionId).toBe(mission.id);
        expect(run.sessionId).toBeUndefined();
    });

    it('links the noninteractive workflow Run to the recorder session', async () => {
        await runAgent(
            {
                mode: 'jsonl',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
                thinking: false,
                sessionId: 'session_noninteractive_run',
                workflowName: 'persist-demo',
                prompt: 'plan the migration',
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            },
            {
                workspaceRoot: workspaceDir,
                resolveSdkModel: () => createCompletingWorkflowModel(),
            },
        );

        const mission = firstRecord(await listMissions({ mcRoot: workspaceDir, dataDir }));
        const run = firstRecord(await listRunsForMission({ mcRoot: workspaceDir, dataDir }, mission.id));
        expect(run.sessionId).toBe('session_noninteractive_run');
    });

    it('records a failed Run when the provider fails', async () => {
        await runAgent(
            {
                mode: 'plain',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
                thinking: false,
                workflowName: 'persist-demo',
                prompt: 'plan the migration',
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            },
            {
                workspaceRoot: workspaceDir,
                resolveSdkModel: () => createFailingWorkflowModel(),
            },
        );

        const location = { mcRoot: workspaceDir, dataDir };
        const missions = await listMissions(location);
        expect(missions).toHaveLength(1);
        const mission = firstRecord(missions);

        const runs = await listRunsForMission(location, mission.id);
        expect(runs).toHaveLength(1);
        const run = firstRecord(runs);
        expect(run.status).toBe('failed');
        expect(run.terminalReason).toBeDefined();
    });

    it('persists a completed Mission and Run for the #name invocation form', async () => {
        await runAgent(
            {
                mode: 'plain',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
                thinking: false,
                prompt: '#persist-demo plan the migration',
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            },
            {
                workspaceRoot: workspaceDir,
                resolveSdkModel: () => createCompletingWorkflowModel(),
            },
        );

        const location = { mcRoot: workspaceDir, dataDir };
        const missions = await listMissions(location);
        expect(missions).toHaveLength(1);
        const mission = firstRecord(missions);
        const runs = await listRunsForMission(location, mission.id);
        expect(firstRecord(runs).status).toBe('completed');
    });

    it('does not persist records for a plain prompt', async () => {
        await runAgent(
            {
                mode: 'plain',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
                thinking: false,
                prompt: 'just a regular prompt',
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            },
            {
                workspaceRoot: workspaceDir,
                resolveSdkModel: () => createCompletingWorkflowModel(),
            },
        );

        const missions = await listMissions({ mcRoot: workspaceDir, dataDir });
        expect(missions).toHaveLength(0);
    });

    it('runs without persisting when no .mc root resolves', async () => {
        const noMcDir = await mkdtemp(join(tmpdir(), 'mctrl-wf-no-mc-'));
        const workflowsDir = join(noMcDir, '.mctrl', 'workflows');
        await mkdir(workflowsDir, { recursive: true });
        await writeFile(
            join(workflowsDir, 'persist-demo.workflow.json'),
            JSON.stringify(WORKFLOW_PERSISTENCE_SPEC),
            'utf8',
        );
        try {
            const output = await runAgent(
                {
                    mode: 'plain',
                    useNative: false,
                    command: 'run',
                    showHelp: false,
                    showVersion: false,
                    thinking: false,
                    workflowName: 'persist-demo',
                    prompt: 'plan the migration',
                    modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                },
                {
                    workspaceRoot: noMcDir,
                    resolveSdkModel: () => createCompletingWorkflowModel(),
                },
            );

            // T8 streaming gate: plain mode returns '' (blocks streamed to stdout).
            expect(output).toBe('');
            const missions = await listMissions({ mcRoot: noMcDir, dataDir });
            expect(missions).toHaveLength(0);
        } finally {
            await rm(noMcDir, { recursive: true, force: true });
        }
    });
});
