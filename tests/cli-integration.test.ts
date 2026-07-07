import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../apps/cli/src/args.js';
import { createProviderAuthStore } from '../apps/cli/src/auth-store.js';
import { runAuthCommand } from '../apps/cli/src/commands/auth.js';
import { createCliProviderForSelection, runAgent } from '../apps/cli/src/commands/run-agent.js';
import { missionControlAuthFileEnvKey } from '../packages/config/src/index.js';
import { missionControlDataDirEnvKey } from '../packages/core/src/memory/data-dir.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

async function useTempDataDir(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'mission-control-cli-integration-data-'));
    tempDirs.push(directory);
    vi.stubEnv(missionControlDataDirEnvKey, directory);
    return directory;
}

async function useTempAuthFile(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'mission-control-cli-integration-'));
    tempDirs.push(directory);
    const authFilePath = join(directory, 'auth.json');
    vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
    return authFilePath;
}

const SMOKE_WORKFLOW_SPEC = {
    name: 'smoke',
    description: 'Smoke-test default workflow for CLI integration',
    graph: {
        id: 'default-smoke',
        version: '0.1.0',
        entryNodeId: 'smoke-entry',
        defaults: {
            model: { providerID: 'local', modelID: 'local-echo' },
            maxNodeRuns: 8,
        },
        nodes: [{ id: 'smoke-entry', kind: 'llm', label: 'Smoke entry node' }],
        edges: [{ source: 'smoke-entry', target: 'smoke-entry', condition: 'smoke-loop', priority: 10 }],
        rules: [{ id: 'smoke-loop', when: { kind: 'blackboard.value.equals', key: 'llm.loop_active', value: true } }],
        policies: [],
    },
} as const;

async function createWorkflowWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mctrl-cli-wf-ws-'));
    tempDirs.push(dir);
    const workflowsDir = join(dir, '.mctrl', 'workflows');
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(join(workflowsDir, 'default.workflow.json'), JSON.stringify(SMOKE_WORKFLOW_SPEC), 'utf8');
    return dir;
}

async function captureStdout<T>(run: () => Promise<T>): Promise<{ readonly result: T; readonly stdout: string }> {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((data: unknown) => {
        writes.push(typeof data === 'string' ? data : String(data));
        return true;
    });
    try {
        const result = await run();
        return { result, stdout: writes.join('') };
    } finally {
        spy.mockRestore();
    }
}

describe('CLI integration', () => {
    beforeEach(async () => {
        await useTempDataDir();
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
    });

    it('streams the plain mode demo report', async () => {
        const { result, stdout } = await captureStdout(() => runAgent(parseArgs(['--no-tui'])));

        expect(result).toBe('');
        expect(stdout).toMatch(/\n> \S+ · \S+\n/u);
    });

    it('emits JSON Lines demo events', async () => {
        const output = await runAgent(parseArgs(['--json']));
        const lines = output
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { readonly type?: string });

        expect(lines.some((line) => line.type === 'session.started')).toBe(true);
        expect(lines.some((line) => line.type === 'task.completed')).toBe(true);
    });

    it('emits selected provider and model through CLI integration', async () => {
        const { result, stdout } = await captureStdout(() =>
            runAgent(parseArgs(['--no-tui', '--provider', 'local', '--model', 'local-echo'])),
        );

        expect(result).toBe('');
        expect(stdout).toContain('> local · local-echo');
    });

    it('uses auth configured provider defaults through CLI integration', async () => {
        const authFilePath = await useTempAuthFile();
        await runAuthCommand(parseArgs(['auth', 'login', '--provider', 'local', '--api-key', 'local_key']), {
            now: '2026-06-03T10:00:00.000Z',
            store: createProviderAuthStore(),
        });

        const { result, stdout } = await captureStdout(() => runAgent(parseArgs(['--no-tui'])));

        expect(result).toBe('');
        expect(stdout).toContain('> local · local-echo');
        await rm(authFilePath, { force: true });
    });

    it('uses auth configured OpenCode provider defaults through CLI integration', async () => {
        const authFilePath = await useTempAuthFile();
        await runAuthCommand(parseArgs(['auth', 'login', '--provider', 'anthropic', '--api-key', 'anthropic_key']), {
            now: '2026-06-03T10:00:00.000Z',
            store: createProviderAuthStore(),
        });

        const { result, stdout } = await captureStdout(() => runAgent(parseArgs(['--no-tui'])));

        expect(result).toBe('');
        expect(stdout).toContain('> anthropic · claude-3-5-sonnet-20240620');
        expect(stdout).not.toContain('anthropic_key');
        await rm(authFilePath, { force: true });
    });

    it('routes a discovered workflow through graph dispatch', async () => {
        const workspaceDir = await createWorkflowWorkspace();
        const configDir = await mkdtemp(join(tmpdir(), 'mctrl-cli-wf-cfg-'));
        vi.stubEnv('MCTRL_CONFIG_DIR', configDir);
        try {
            const provider = createCliProviderForSelection(
                { providerID: 'local', modelID: 'local-echo' },
                createProviderAuthStore(),
            );
            const output = await runAgent(
                parseArgs([
                    '--json',
                    '--workspace',
                    workspaceDir,
                    '#smoke hello',
                    '--provider',
                    'local',
                    '--model',
                    'local-echo',
                ]),
                { provider, workspaceRoot: workspaceDir },
            );
            const records = output
                .trim()
                .split('\n')
                .map(
                    (line) =>
                        JSON.parse(line) as {
                            readonly type?: string;
                            readonly abg?: {
                                readonly graphId?: string;
                                readonly nodeId?: string;
                                readonly nodeKind?: string;
                            };
                        },
                );

            expect(records).toContainEqual(
                expect.objectContaining({
                    type: 'graph.started',
                    abg: expect.objectContaining({ graphId: 'default-smoke' }),
                }),
            );
            expect(records).toContainEqual(
                expect.objectContaining({
                    type: 'node.started',
                    abg: expect.objectContaining({
                        graphId: 'default-smoke',
                        nodeId: 'smoke-entry',
                        nodeKind: 'llm',
                    }),
                }),
            );
        } finally {
            await rm(workspaceDir, { recursive: true, force: true });
            await rm(configDir, { recursive: true, force: true });
        }
    });
});
