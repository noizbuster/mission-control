import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../apps/cli/src/args.js';
import { createProviderAuthStore } from '../apps/cli/src/auth-store.js';
import { runAuthCommand } from '../apps/cli/src/commands/auth.js';
import { createCliProviderForSelection, runAgent } from '../apps/cli/src/commands/run-agent.js';
import { missionControlAuthFileEnvKey } from '../packages/config/src/index.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function useTempAuthFile(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'mission-control-cli-integration-'));
    const authFilePath = join(directory, 'auth.json');
    vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
    return authFilePath;
}

const SMOKE_WORKFLOW_SPEC = {
    name: 'default',
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
    const workflowsDir = join(dir, '.mctrl', 'workflows');
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(join(workflowsDir, 'default.workflow.json'), JSON.stringify(SMOKE_WORKFLOW_SPEC), 'utf8');
    return dir;
}

describe('CLI integration', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('emits the plain mode demo report', async () => {
        const output = await runAgent(parseArgs(['--no-tui']));

        expect(output).toContain('mission-control');
        expect(output).toContain('mctrl');
        expect(output).toContain('task.completed');
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
        const output = await runAgent(parseArgs(['--no-tui', '--provider', 'local', '--model', 'local-echo']));

        expect(output).toContain('provider: local');
        expect(output).toContain('model: local-echo');
        expect(output).toContain('selection: local/local-echo');
        expect(output).toContain('task.completed');
    });

    it('uses auth configured provider defaults through CLI integration', async () => {
        const authFilePath = await useTempAuthFile();
        await runAuthCommand(parseArgs(['auth', 'login', '--provider', 'local', '--api-key', 'local_key']), {
            now: '2026-06-03T10:00:00.000Z',
            store: createProviderAuthStore(),
        });

        const output = await runAgent(parseArgs(['--no-tui']));

        expect(output).toContain('provider: local');
        expect(output).toContain('model: local-echo');
        expect(output).toContain('selection: local/local-echo');
        await rm(authFilePath, { force: true });
    });

    it('uses auth configured OpenCode provider defaults through CLI integration', async () => {
        const authFilePath = await useTempAuthFile();
        await runAuthCommand(parseArgs(['auth', 'login', '--provider', 'anthropic', '--api-key', 'anthropic_key']), {
            now: '2026-06-03T10:00:00.000Z',
            store: createProviderAuthStore(),
        });

        const output = await runAgent(parseArgs(['--no-tui']));

        expect(output).toContain('provider: anthropic');
        expect(output).toContain('model: claude-3-5-haiku-20241022');
        expect(output).toContain('selection: anthropic/claude-3-5-haiku-20241022');
        expect(output).toContain('task.completed');
        expect(output).not.toContain('anthropic_key');
        await rm(authFilePath, { force: true });
    });

    it('routes #default hello through workflow discovery to graph dispatch', async () => {
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
                    '--no-tui',
                    '--workspace',
                    workspaceDir,
                    '#default hello',
                    '--provider',
                    'local',
                    '--model',
                    'local-echo',
                ]),
                { provider, workspaceRoot: workspaceDir },
            );

            expect(output).toContain('graph=default-smoke');
            expect(output).toContain('node=smoke-entry mode=llm');
        } finally {
            await rm(workspaceDir, { recursive: true, force: true });
            await rm(configDir, { recursive: true, force: true });
        }
    });
});
