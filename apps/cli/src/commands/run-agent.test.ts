import { missionControlAuthFileEnvKey } from '@mission-control/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderAuthStore } from '../auth-store.js';
import { runAgent } from './run-agent.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function useTempAuthFile(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'mission-control-run-agent-auth-'));
    const authFilePath = join(directory, 'auth.json');
    vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
    return authFilePath;
}

describe('runAgent plain reporter', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('plain reporter prints stable mission-control summary', async () => {
        const output = await runAgent({
            mode: 'plain',
            useNative: false,
            command: 'run',
            showHelp: false,
            showVersion: false,
        });

        expect(output).toContain('mission-control');
        expect(output).toContain('mctrl');
        expect(output).toContain('session_');
        expect(output).toContain('task.completed');
        expect(output).toContain('completed by mock sidecar');
    });

    it('plain reporter prints the selected provider and model', async () => {
        const output = await runAgent({
            mode: 'plain',
            useNative: false,
            command: 'run',
            showHelp: false,
            showVersion: false,
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
            },
        });

        expect(output).toContain('provider: local');
        expect(output).toContain('model: local-echo');
        expect(output).toContain('selection: local/local-echo');
    });

    it('rejects unknown provider model combinations before running', async () => {
        await expect(
            runAgent({
                mode: 'plain',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
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

        const output = await runAgent(
            {
                mode: 'plain',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
            },
            { authStore: store },
        );

        expect(output).toContain('provider: local');
        expect(output).toContain('model: local-echo');
        expect(output).toContain('selection: local/local-echo');
        await rm(authFilePath, { force: true });
    });

    it('uses configured OpenCode provider defaults when no provider flags are passed', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        await store.saveCredential({
            providerID: 'anthropic',
            modelID: 'claude-3-5-haiku-20241022',
            fields: [{ id: 'apiKey', value: 'anthropic_secret_key', secret: true }],
            now: '2026-06-03T10:00:00.000Z',
        });

        const output = await runAgent(
            {
                mode: 'plain',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
            },
            { authStore: store },
        );

        expect(output).toContain('provider: anthropic');
        expect(output).toContain('model: claude-3-5-haiku-20241022');
        expect(output).toContain('selection: anthropic/claude-3-5-haiku-20241022');
        expect(output).toContain('task.completed');
        expect(output).not.toContain('anthropic_secret_key');
        await rm(authFilePath, { force: true });
    });

    it('validates explicit generated provider model selections', async () => {
        const output = await runAgent({
            mode: 'plain',
            useNative: false,
            command: 'run',
            showHelp: false,
            showVersion: false,
            modelProviderSelection: {
                providerID: 'anthropic',
                modelID: 'claude-sonnet-4-6',
                variantID: 'thinking',
            },
        });

        expect(output).toContain('provider: anthropic');
        expect(output).toContain('model: claude-sonnet-4-6');
        expect(output).toContain('variant: thinking');
        expect(output).toContain('selection: anthropic/claude-sonnet-4-6#thinking');
        expect(output).toContain('task.completed');
    });

    it('plain reporter prints graph node mode for authored graph events', async () => {
        const output = await runAgent({
            mode: 'plain',
            useNative: false,
            command: 'run',
            showHelp: false,
            showVersion: false,
            graphPath: 'examples/abg/coding-agent.graph.json',
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
            },
        });

        expect(output).toContain('provider: local');
        expect(output).toContain('model: local-echo');
        expect(output).toContain('selection: local/local-echo');
        expect(output).toContain('node=chat-intake mode=llm');
        expect(output).toContain('node=repo-analysis mode=tool');
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
                graphPath,
            }),
        ).rejects.toThrow('unknown ABG edge condition rule: missing-rule');
        await rm(directory, { recursive: true, force: true });
    });
});
