import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const WORKFLOW_PERSISTENCE_SPEC = {
    name: 'persist-demo',
    description: 'Test workflow for noninteractive persistence',
    graph: {
        id: 'persist-demo-graph',
        version: '0.1.0',
        entryNodeId: 'persist-intake',
        defaults: { model: { providerID: 'local', modelID: 'local-echo' }, maxNodeRuns: 10 },
        nodes: [{ id: 'persist-intake', kind: 'llm', label: 'Persist intake' }],
        edges: [{ source: 'persist-intake', target: 'persist-intake', condition: 'persist-loop', priority: 10 }],
        rules: [{ id: 'persist-loop', when: { kind: 'blackboard.value.equals', key: 'llm.loop_active', value: true } }],
        policies: [],
    },
} as const;

export type WorkflowPersistenceFixture = {
    readonly workspaceDir: string;
    readonly configDir: string;
    readonly dataDir: string;
};

export async function createWorkflowPersistenceFixture(): Promise<WorkflowPersistenceFixture> {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'mctrl-wf-persist-ws-'));
    await mkdir(join(workspaceDir, '.mc'), { recursive: true });
    const workflowsDir = join(workspaceDir, '.mctrl', 'workflows');
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(
        join(workflowsDir, 'persist-demo.workflow.json'),
        JSON.stringify(WORKFLOW_PERSISTENCE_SPEC),
        'utf8',
    );
    return {
        workspaceDir,
        configDir: await mkdtemp(join(tmpdir(), 'mctrl-wf-persist-cfg-')),
        dataDir: join(workspaceDir, 'data'),
    };
}

export async function removeWorkflowPersistenceFixture(fixture: WorkflowPersistenceFixture): Promise<void> {
    await Promise.all([
        rm(fixture.workspaceDir, { recursive: true, force: true }),
        rm(fixture.configDir, { recursive: true, force: true }),
    ]);
}

export function createCompletingWorkflowModel(beforeStream?: () => Promise<void>): MockLanguageModelV3 {
    const usage = {
        inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 6, text: 6, reasoning: 0 },
    };
    const chunks: LanguageModelV3StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Done.' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
    ];
    return new MockLanguageModelV3({
        provider: 'local',
        modelId: 'local-echo',
        doStream: async () => {
            await beforeStream?.();
            return { stream: convertArrayToReadableStream(chunks) };
        },
    });
}

export function createFailingWorkflowModel(): MockLanguageModelV3 {
    return new MockLanguageModelV3({
        provider: 'local',
        modelId: 'local-echo',
        doStream: async () => {
            throw new Error('provider stream failed');
        },
    });
}

export function firstRecord<Value>(items: readonly Value[]): Value {
    const head = items[0];
    if (head === undefined) throw new Error('expected at least one record');
    return head;
}
