import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { missionControlAuthFileEnvKey } from '@mission-control/config';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderAuthStore } from '../auth-store';
import { runAgent } from './run-agent';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function useTempAuthFile(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'mission-control-run-agent-auth-'));
    const authFilePath = join(directory, 'auth.json');
    vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
    return authFilePath;
}

/**
 * Capture process.stdout.write calls during a runAgent invocation. Since T7,
 * PlainRenderer/TuiRenderer stream each rendered block to stdout during
 * render() (not at getOutput()), and T8's streaming gate makes runAgent
 * return '' for streamed renderers. To assert on block-formatted output in
 * integration tests, we must capture what was written to stdout.
 */
async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string }> {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((data: unknown) => {
        writes.push(typeof data === 'string' ? data : String(data));
        return true;
    });
    try {
        const result = await fn();
        return { result, stdout: writes.join('') };
    } finally {
        spy.mockRestore();
    }
}

describe('runAgent plain reporter', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('plain reporter prints stable mission-control summary', async () => {
        const { result, stdout } = await captureStdout(() =>
            runAgent({
                mode: 'plain',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
                thinking: false,
            }),
        );

        // T8 streaming gate: plain mode returns '' (blocks were streamed to stdout).
        expect(result).toBe('');
        // The session-header block is streamed to stdout. The default model
        // depends on the environment's configured credentials, so assert on
        // the block structure rather than a specific provider/model.
        expect(stdout).toMatch(/\n> \S+ · \S+\n/);
    });

    it('plain reporter prints the selected provider and model', async () => {
        const { result, stdout } = await captureStdout(() =>
            runAgent({
                mode: 'plain',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
                thinking: false,
                modelProviderSelection: {
                    providerID: 'local',
                    modelID: 'local-echo',
                },
            }),
        );

        expect(result).toBe('');
        expect(stdout).toContain('> local \u00b7 local-echo');
    });

    it('rejects unknown provider model combinations before running', async () => {
        await expect(
            runAgent({
                mode: 'plain',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
                thinking: false,
                modelProviderSelection: {
                    providerID: 'local',
                    modelID: 'removed-model',
                },
            }),
        ).rejects.toThrow('Model removed-model is not available for provider local');

        await expect(
            runAgent({
                mode: 'plain',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
                thinking: false,
                modelProviderSelection: {
                    providerID: 'unknown',
                    modelID: 'removed-model',
                },
            }),
        ).rejects.toThrow('Unknown provider: unknown');
    });

    it('uses configured default model when no provider flags are passed', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        await store.saveCredential({
            providerID: 'local',
            modelID: 'local-echo',
            apiKey: 'local_key',
            now: '2026-06-03T10:00:00.000Z',
        });

        const { result, stdout } = await captureStdout(() =>
            runAgent(
                {
                    mode: 'plain',
                    useNative: false,
                    command: 'run',
                    showHelp: false,
                    showVersion: false,
                    thinking: false,
                },
                { authStore: store },
            ),
        );

        expect(result).toBe('');
        expect(stdout).toContain('> local \u00b7 local-echo');
        await rm(authFilePath, { force: true });
    });

    it('uses configured OpenCode provider defaults when no provider flags are passed', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        await store.saveCredential({
            providerID: 'anthropic',
            modelID: 'claude-haiku-4-5',
            fields: [{ id: 'apiKey', value: 'anthropic_secret_key', secret: true }],
            now: '2026-06-03T10:00:00.000Z',
        });

        const { result, stdout } = await captureStdout(() =>
            runAgent(
                {
                    mode: 'plain',
                    useNative: false,
                    command: 'run',
                    showHelp: false,
                    showVersion: false,
                    thinking: false,
                },
                { authStore: store },
            ),
        );

        expect(result).toBe('');
        expect(stdout).toContain('> anthropic \u00b7 claude-haiku-4-5');
        expect(stdout).not.toContain('anthropic_secret_key');
        await rm(authFilePath, { force: true });
    });

    it('validates explicit generated provider model selections', async () => {
        const { result, stdout } = await captureStdout(() =>
            runAgent({
                mode: 'plain',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
                thinking: false,
                modelProviderSelection: {
                    providerID: 'anthropic',
                    modelID: 'claude-sonnet-4-6',
                    variantID: 'thinking-high',
                },
            }),
        );

        expect(result).toBe('');
        expect(stdout).toContain('> anthropic \u00b7 claude-sonnet-4-6#thinking-high');
    });

    it('runs an authored graph through the plain reporter without error', async () => {
        const { result } = await captureStdout(() =>
            runAgent({
                mode: 'plain',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
                thinking: false,
                graphPath: 'examples/abg/coding-agent.graph.json',
                modelProviderSelection: {
                    providerID: 'local',
                    modelID: 'local-echo',
                },
            }),
        );

        // Streaming gate: plain mode returns '' (blocks streamed to stdout).
        // Graph node metadata (node.started/node.completed) does not produce
        // OutputBlocks by design — only session-header/text/tool/reasoning/error do.
        expect(result).toBe('');
    });

    it('rejects malformed graph files before running', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'mission-control-bad-graph-'));
        const graphPath = join(directory, 'bad.graph.json');
        await writeFile(
            graphPath,
            JSON.stringify({
                id: 'bad-cli-graph',
                entryNodeId: 'start',
                nodes: [
                    {
                        id: 'start',
                        kind: 'action',
                    },
                ],
                edges: [
                    {
                        source: 'start',
                        target: 'missing',
                    },
                ],
                rules: [],
                policies: [],
            }),
            'utf8',
        );

        await expect(
            runAgent({
                mode: 'plain',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
                thinking: false,
                graphPath,
            }),
        ).rejects.toThrow('unknown ABG edge target: missing');
        await rm(directory, { recursive: true, force: true });
    });

    it('rejects graph files with unknown edge condition rules before running', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'mission-control-bad-edge-rule-'));
        const graphPath = join(directory, 'bad-edge-rule.graph.json');
        await writeFile(
            graphPath,
            JSON.stringify({
                id: 'bad-cli-edge-rule',
                entryNodeId: 'start',
                nodes: [
                    {
                        id: 'start',
                        kind: 'action',
                    },
                    {
                        id: 'next',
                        kind: 'action',
                    },
                ],
                edges: [
                    {
                        source: 'start',
                        target: 'next',
                        condition: 'missing-rule',
                    },
                ],
                rules: [],
                policies: [],
            }),
            'utf8',
        );

        await expect(
            runAgent({
                mode: 'plain',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
                thinking: false,
                graphPath,
            }),
        ).rejects.toThrow('unknown ABG edge condition rule: missing-rule');
        await rm(directory, { recursive: true, force: true });
    });
});

const PLANNER_WORKFLOW = {
    name: 'planner',
    description: 'Test planner workflow for Task 2.7',
    graph: {
        id: 'planner-test-graph',
        version: '0.1.0',
        entryNodeId: 'planner-intake',
        defaults: {
            model: { providerID: 'local', modelID: 'local-echo' },
            maxNodeRuns: 10,
        },
        nodes: [{ id: 'planner-intake', kind: 'llm', label: 'Planner intake' }],
        edges: [{ source: 'planner-intake', target: 'planner-intake', condition: 'planner-loop', priority: 10 }],
        rules: [
            {
                id: 'planner-loop',
                when: { kind: 'blackboard.value.equals', key: 'llm.loop_active', value: true },
            },
        ],
        policies: [],
    },
} as const;

function buildMockUsage() {
    return {
        inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 6, text: 6, reasoning: 0 },
    };
}

function finalTextChunks(): LanguageModelV3StreamPart[] {
    return [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Done.' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: buildMockUsage() },
    ];
}

function createMockModel(): MockLanguageModelV3 {
    return new MockLanguageModelV3({
        provider: 'local',
        modelId: 'local-echo',
        doStream: async () => ({ stream: convertArrayToReadableStream(finalTextChunks()) }),
    });
}

async function createWorkflowWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mctrl-workflow-ws-'));
    const workflowsDir = join(dir, '.mctrl', 'workflows');
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(join(workflowsDir, 'planner.workflow.json'), JSON.stringify(PLANNER_WORKFLOW), 'utf8');
    return dir;
}

describe('runAgent workflow invocation', () => {
    let workspaceDir: string;
    let configDir: string;

    beforeEach(async () => {
        workspaceDir = await createWorkflowWorkspace();
        configDir = await mkdtemp(join(tmpdir(), 'mctrl-workflow-cfg-'));
        vi.stubEnv('MCTRL_CONFIG_DIR', configDir);
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(workspaceDir, { recursive: true, force: true });
        await rm(configDir, { recursive: true, force: true });
    });

    it('routes #name prompt to the discovered workflow graph', async () => {
        const mockModel = createMockModel();
        const { result } = await captureStdout(() =>
            runAgent(
                {
                    mode: 'plain',
                    useNative: false,
                    command: 'run',
                    showHelp: false,
                    showVersion: false,
                    thinking: false,
                    prompt: '#planner plan the migration',
                    modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                },
                {
                    workspaceRoot: workspaceDir,
                    resolveSdkModel: () => mockModel,
                },
            ),
        );

        // Streaming gate: plain mode returns ''.
        expect(result).toBe('');
        // The planner workflow graph was discovered and invoked: the mock model
        // was called at least once (proving the graph ran a model turn).
        expect(mockModel.doStreamCalls.length).toBeGreaterThan(0);
    });

    it('routes --workflow flag to the discovered workflow graph', async () => {
        const mockModel = createMockModel();
        const { result } = await captureStdout(() =>
            runAgent(
                {
                    mode: 'plain',
                    useNative: false,
                    command: 'run',
                    showHelp: false,
                    showVersion: false,
                    thinking: false,
                    workflowName: 'planner',
                    prompt: 'plan the migration',
                    modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                },
                {
                    workspaceRoot: workspaceDir,
                    resolveSdkModel: () => mockModel,
                },
            ),
        );

        expect(result).toBe('');
        expect(mockModel.doStreamCalls.length).toBeGreaterThan(0);
    });

    it('throws on unknown #workflow name with available workflows listed', async () => {
        await expect(
            runAgent(
                {
                    mode: 'plain',
                    useNative: false,
                    command: 'run',
                    showHelp: false,
                    showVersion: false,
                    thinking: false,
                    prompt: '#nonexistent do something',
                    modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                },
                { workspaceRoot: workspaceDir },
            ),
        ).rejects.toThrow('Unknown workflow "nonexistent"');
    });

    it('throws on unknown --workflow name with available workflows listed', async () => {
        await expect(
            runAgent(
                {
                    mode: 'plain',
                    useNative: false,
                    command: 'run',
                    showHelp: false,
                    showVersion: false,
                    thinking: false,
                    workflowName: 'nonexistent',
                    prompt: 'do something',
                    modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                },
                { workspaceRoot: workspaceDir },
            ),
        ).rejects.toThrow('Unknown workflow "nonexistent"');
    });

    it('does not treat a normal prompt as a workflow invocation', async () => {
        const mockModel = createMockModel();
        const { result, stdout } = await captureStdout(() =>
            runAgent(
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
                    resolveSdkModel: () => mockModel,
                },
            ),
        );

        expect(result).toBe('');
        // The planner graph was NOT invoked for a non-# prompt.
        expect(stdout).not.toContain('planner-test-graph');
    });
});
