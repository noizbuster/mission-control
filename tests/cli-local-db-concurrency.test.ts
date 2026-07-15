import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openMissionControlDb } from '../packages/core/src/db/mission-control-db.js';
import {
    makeTask12TempRoot,
    type ProcessResult,
    resolveBuiltCliEntryPath,
    startBuiltCli,
    startLockHolder,
    startPreopenedBuiltCli,
    terminateTask12Processes,
} from './cli-local-db-concurrency-support.js';
import { access, chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const forbiddenSuccessStderr = /SQLITE_BUSY|database is locked|client closed/iu;
const retiredDatabaseFilename = ['memory', 'db'].join('.');
const roots: string[] = [];

beforeAll(() => {
    resolveBuiltCliEntryPath();
});

afterEach(async () => {
    await terminateTask12Processes();
});

afterAll(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('built CLI unified database concurrency', () => {
    it('drains two concurrent local runs and one workflow into the data-dir database before exit', async () => {
        // Given: two built CLI processes share isolated data/config/workspace roots without provider credentials.
        const fixture = await createFixture('happy');
        const firstSessionId = 'task12-concurrent-a';
        const secondSessionId = 'task12-concurrent-b';
        const workflowSessionId = 'task12-workflow';
        const initialized = await openMissionControlDb({ dataDir: fixture.dataDir });
        initialized.close();
        const first = startBuiltCli(runArgs(firstSessionId, 'first concurrent prompt'), fixture.env, firstSessionId);
        const second = startBuiltCli(
            runArgs(secondSessionId, 'second concurrent prompt'),
            fixture.env,
            secondSessionId,
        );

        // When: both processes settle, a real workflow runs, and public replay opens each durable session.
        const concurrentResults = await Promise.all([first.waitForExit(), second.waitForExit()]);
        const workflowResult = await startBuiltCli(
            [...runArgs(workflowSessionId, 'workflow persistence prompt'), '--workflow', 'task12-workflow'],
            fixture.env,
        ).waitForExit();
        const replayResults = await Promise.all(
            [firstSessionId, secondSessionId, workflowSessionId].map((sessionId) =>
                startBuiltCli(['session', 'replay', sessionId, '--jsonl'], fixture.env).waitForExit(),
            ),
        );

        // Then: process output is clean and all queued event/job/workflow writes are visible after final close.
        for (const result of [...concurrentResults, workflowResult, ...replayResults]) assertSuccessfulProcess(result);
        expect(replayResults[0]?.stdout).toContain(firstSessionId);
        expect(replayResults[1]?.stdout).toContain(secondSessionId);
        expect(replayResults[2]?.stdout).toContain(workflowSessionId);

        const runtime = await openMissionControlDb({ dataDir: fixture.dataDir });
        try {
            const sessions = await runtime.client.execute(
                'SELECT session_id, last_event_seq FROM sessions WHERE session_id IN (?, ?, ?) ORDER BY session_id',
                [firstSessionId, secondSessionId, workflowSessionId],
            );
            expect(sessions.rows).toHaveLength(3);
            expect(sessions.rows.every((row) => Number(row[1]) > 0)).toBe(true);

            const jobs = await runtime.client.execute(
                'SELECT child_session_id, agent_id, status, result_json FROM async_jobs ORDER BY child_session_id',
            );
            expect(jobs.rows).toEqual([
                {
                    child_session_id: firstSessionId,
                    agent_id: 'task-12-drain',
                    status: 'completed',
                    result_json: `{"status":"completed","output":"drained ${firstSessionId}"}`,
                },
                {
                    child_session_id: secondSessionId,
                    agent_id: 'task-12-drain',
                    status: 'completed',
                    result_json: `{"status":"completed","output":"drained ${secondSessionId}"}`,
                },
            ]);

            const workflowRows = await runtime.client.execute(
                "SELECT m.workflow_name, r.status FROM missions m JOIN mission_runs r ON r.mission_id = m.mission_id WHERE m.workflow_name = 'task12-workflow'",
            );
            expect(workflowRows.rows).toEqual([{ workflow_name: 'task12-workflow', status: 'completed' }]);
            await expectPragmasAndIntegrity(runtime);
        } finally {
            runtime.close();
        }

        await expectUnifiedDatabaseFiles(fixture);
    }, 45_000);

    it('surfaces the real 5000ms busy failure without fallback and remains healthy afterward', async () => {
        // Given: a real product-opener worker holds BEGIN IMMEDIATE on the shared target.
        const fixture = await createFixture('timeout');
        const startPath = join(fixture.root, 'start-blocked-cli');
        const releasePath = join(fixture.root, 'release-lock-holder');
        const blockedProcess = startPreopenedBuiltCli(
            runArgs('task12-timeout', 'must hit busy timeout'),
            fixture.env,
            startPath,
        );
        await blockedProcess.waitForMarker('PREOPENED');
        const holder = startLockHolder(fixture.dataDir, releasePath);
        await holder.waitForMarker('READY');
        await holder.waitForMarker('LOCKED');

        // When: the built CLI attempts a durable run while the lock remains held past busy_timeout.
        await writeFile(startPath, 'start', 'utf8');
        const blocked = await blockedProcess.waitForExit(10_000);

        // Then: failure is explicit, release recovers the same target, and no migration fallback appears.
        expect(blocked.code).toBe(1);
        expect(blocked.signal).toBeNull();
        expect(blocked.stderr).toMatch(/SQLITE_BUSY|busy|locked/iu);
        await writeFile(releasePath, 'release', 'utf8');
        await holder.waitForMarker('COMMITTED');
        expect(await holder.waitForExit()).toMatchObject({ code: 0, signal: null });

        const recoverySessionId = 'task12-timeout-recovery';
        const recovery = await startBuiltCli(runArgs(recoverySessionId, 'recovery prompt'), fixture.env).waitForExit();
        assertSuccessfulProcess(recovery);
        const replay = await startBuiltCli(
            ['session', 'replay', recoverySessionId, '--jsonl'],
            fixture.env,
        ).waitForExit();
        assertSuccessfulProcess(replay);
        expect(replay.stdout).toContain(recoverySessionId);

        const runtime = await openMissionControlDb({ dataDir: fixture.dataDir });
        try {
            const blockedSession = await runtime.client.execute(
                "SELECT session_id FROM sessions WHERE session_id = 'task12-timeout'",
            );
            const heldRow = await runtime.client.execute(
                "SELECT key FROM memory_entries WHERE namespace = 'task-11' AND key = 'task-12-held-row'",
            );
            expect(blockedSession.rows).toEqual([]);
            expect(heldRow.rows).toEqual([{ key: 'task-12-held-row' }]);
            await expectPragmasAndIntegrity(runtime);
        } finally {
            runtime.close();
        }
        await expectUnifiedDatabaseFiles(fixture);
    }, 30_000);
});

type Task12Fixture = {
    readonly root: string;
    readonly dataDir: string;
    readonly workspaceDir: string;
    readonly env: NodeJS.ProcessEnv;
};

async function createFixture(name: string): Promise<Task12Fixture> {
    const root = await makeTask12TempRoot(name);
    roots.push(root);
    const dataDir = join(root, 'data');
    const workspaceDir = join(root, 'workspace');
    const configDir = join(root, 'config');
    const homeDir = join(root, 'home');
    await Promise.all([
        mkdir(dataDir, { recursive: true }),
        mkdir(join(workspaceDir, '.omo'), { recursive: true }),
        mkdir(join(workspaceDir, '.mctrl', 'workflows'), { recursive: true }),
        mkdir(configDir, { recursive: true }),
        mkdir(homeDir, { recursive: true }),
    ]);
    await chmod(dataDir, 0o700);
    await writeFile(
        join(workspaceDir, '.mctrl', 'workflows', 'task12-workflow.workflow.json'),
        JSON.stringify({
            name: 'task12-workflow',
            description: 'Task 12 deterministic persistence workflow',
            graph: {
                id: 'task12-workflow-graph',
                version: '0.1.0',
                entryNodeId: 'answer',
                defaults: { model: { providerID: 'local', modelID: 'local-echo' }, maxNodeRuns: 4 },
                nodes: [{ id: 'answer', kind: 'llm', label: 'Deterministic local answer' }],
                edges: [],
                rules: [],
                policies: [],
            },
        }),
        'utf8',
    );
    return {
        root,
        dataDir,
        workspaceDir,
        env: {
            PATH: process.env.PATH,
            HOME: homeDir,
            TMPDIR: root,
            NO_COLOR: '1',
            NODE_NO_WARNINGS: '1',
            CI: '1',
            MCTRL_DATA_DIR: dataDir,
            MCTRL_CONFIG_DIR: configDir,
            MCTRL_WORKSPACE: workspaceDir,
            MISSION_CONTROL_AUTH_FILE: join(root, 'auth.json'),
            XDG_CONFIG_HOME: join(root, 'xdg-config'),
            XDG_DATA_HOME: join(root, 'xdg-data'),
        },
    };
}

function runArgs(sessionId: string, prompt: string): readonly string[] {
    return ['run', prompt, '--session', sessionId, '--jsonl', '--provider', 'local', '--model', 'local-echo'];
}

function assertSuccessfulProcess(result: ProcessResult): void {
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(result.stderr).not.toMatch(forbiddenSuccessStderr);
}

async function expectPragmasAndIntegrity(runtime: Awaited<ReturnType<typeof openMissionControlDb>>): Promise<void> {
    expect((await runtime.client.execute('PRAGMA journal_mode')).rows).toEqual([{ journal_mode: 'wal' }]);
    expect((await runtime.client.execute('PRAGMA synchronous')).rows).toEqual([{ synchronous: 1 }]);
    expect((await runtime.client.execute('PRAGMA busy_timeout')).rows).toEqual([{ timeout: 5000 }]);
    expect((await runtime.client.execute('PRAGMA integrity_check')).rows).toEqual([{ integrity_check: 'ok' }]);
}

async function expectUnifiedDatabaseFiles(fixture: Task12Fixture): Promise<void> {
    const dataFiles = await readdir(fixture.dataDir);
    expect(dataFiles.filter((name) => name.endsWith('.db'))).toEqual(['mission-control.db']);
    expect(
        dataFiles.every((name) =>
            ['mission-control.db', 'mission-control.db-wal', 'mission-control.db-shm'].includes(name),
        ),
    ).toBe(true);
    await expect(access(join(fixture.dataDir, retiredDatabaseFilename))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(fixture.workspaceDir, retiredDatabaseFilename))).rejects.toMatchObject({ code: 'ENOENT' });
}
