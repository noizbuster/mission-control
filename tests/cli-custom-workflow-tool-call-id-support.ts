import { makeTask12TempRoot, type ProcessResult, startBuiltCli } from './cli-local-db-concurrency-support';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const customWorkflowSource = join(process.cwd(), 'examples', 'abg', 'custom-example.workflow.jsonc');

export type CustomWorkflowFixture = {
    readonly root: string;
    readonly dataDir: string;
    readonly env: NodeJS.ProcessEnv;
};

export async function createCustomWorkflowFixture(name: string): Promise<CustomWorkflowFixture> {
    const root = await makeTask12TempRoot(`custom-workflow-${name}`);
    const dataDir = join(root, 'data');
    const workspaceDir = join(root, 'workspace');
    const configDir = join(root, 'config');
    const homeDir = join(root, 'home');
    const workflowDirectory = join(workspaceDir, '.mctrl', 'workflows');
    await Promise.all([
        mkdir(dataDir, { recursive: true }),
        mkdir(join(workspaceDir, '.omo'), { recursive: true }),
        mkdir(workflowDirectory, { recursive: true }),
        mkdir(configDir, { recursive: true }),
        mkdir(homeDir, { recursive: true }),
    ]);
    await chmod(dataDir, 0o700);
    await Promise.all([
        writeFile(
            join(workflowDirectory, 'custom-example.workflow.jsonc'),
            await readFile(customWorkflowSource, 'utf8'),
            'utf8',
        ),
        writeFile(
            join(workflowDirectory, 'failing-tool.workflow.json'),
            JSON.stringify({
                name: 'failing-tool',
                description: 'Workflow with a deterministic unknown-tool failure.',
                graph: {
                    id: 'failing-tool',
                    version: '0.1.0',
                    entryNodeId: 'failing-tool-node',
                    defaults: { model: { providerID: 'local', modelID: 'local-echo' }, maxNodeRuns: 2 },
                    nodes: [
                        {
                            id: 'failing-tool-node',
                            kind: 'tool',
                            config: { tool: 'definitely-missing-tool', arguments: {} },
                        },
                    ],
                    edges: [],
                    rules: [],
                    policies: [],
                },
            }),
            'utf8',
        ),
    ]);
    return {
        root,
        dataDir,
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

export function workflowArgs(sessionId: string, workflowName = 'custom-example'): readonly string[] {
    return [
        'run',
        'Summarize the available project context.',
        '--workflow',
        workflowName,
        '--session',
        sessionId,
        '--jsonl',
        '--provider',
        'local',
        '--model',
        'local-echo',
    ];
}

export function runWorkflow(
    sessionId: string,
    fixture: CustomWorkflowFixture,
    workflowName = 'custom-example',
): Promise<ProcessResult> {
    return startBuiltCli(workflowArgs(sessionId, workflowName), fixture.env).waitForExit();
}
