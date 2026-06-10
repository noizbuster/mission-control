import { missionControlAuthFileEnvKey } from '@mission-control/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { createProviderAuthStore } from '../auth-store.js';
import { runAgent } from './run-agent.js';
import {
    createAuthStoreWithSummaries,
    createBufferedChatOutput,
    createCredentialSummary,
    createFieldsCredential,
    createScriptedChatInput,
} from './run-agent-chat-test-support.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runAgent model validation', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('rejects explicit variants for models without variant catalogs', async () => {
        await expect(runWithSelection('openai', 'gpt-4o-mini', 'reasoning-high')).rejects.toThrow(
            'Variant reasoning-high is not available for model openai/gpt-4o-mini',
        );
    });

    it('rejects persisted defaults with stale variants for no-variant models', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        await store.saveCredential({
            providerID: 'openai',
            modelID: 'gpt-5',
            variantID: 'reasoning-high',
            apiKey: 'sk-test-secret',
            now: '2026-06-03T10:00:00.000Z',
        });
        await store.setDefaultSelection({ providerID: 'openai', modelID: 'gpt-4o-mini', variantID: 'reasoning-high' });

        await expect(runAgent(baseRunOptions(), { authStore: store })).rejects.toThrow(
            'Variant reasoning-high is not available for model openai/gpt-4o-mini',
        );
        await rm(authFilePath, { force: true });
    });

    it('rejects graph defaults with stale variants for no-variant models', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'mission-control-stale-variant-graph-'));
        const graphPath = join(directory, 'stale-variant.graph.json');
        await writeFile(graphPath, JSON.stringify(staleVariantDefaultGraph()), 'utf8');

        await expect(runAgent({ ...baseRunOptions(), graphPath })).rejects.toThrow(
            'Variant reasoning-high is not available for model openai/gpt-4o-mini',
        );
        await rm(directory, { recursive: true, force: true });
    });

    it('rejects graph fallbacks with stale variants for no-variant models', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'mission-control-stale-variant-fallback-'));
        const graphPath = join(directory, 'stale-variant-fallback.graph.json');
        await writeFile(graphPath, JSON.stringify(staleVariantFallbackGraph()), 'utf8');

        await expect(runAgent({ ...baseRunOptions(), graphPath })).rejects.toThrow(
            'Variant reasoning-high is not available for model openai/gpt-4o-mini',
        );
        await rm(directory, { recursive: true, force: true });
    });

    it('does not start a provider request after an invalid stale /model command', async () => {
        const requests: string[] = [];
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(baseChatOptions(), {
            authStore: createAuthStoreWithSummaries([createCredentialSummary('openai')], {
                openai: createFieldsCredential('openai', 'sk-test-secret'),
            }),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/model openai/gpt-4o-mini#reasoning-high' },
                { type: 'line', value: '/exit' },
            ]),
            chatOutput: chatOutput.output,
            createProvider: (selection) => ({
                async *streamTurn(request) {
                    requests.push(`${selection.providerID}/${selection.modelID}`);
                    yield {
                        kind: 'response_completed' as const,
                        requestId: request.requestId,
                        sequence: 1,
                        message: { messageId: `message_${request.turnId}`, role: 'assistant' as const, content: 'done' },
                        finishReason: 'stop' as const,
                    };
                },
            }),
        });

        expect(output).toContain('Variant reasoning-high is not available for model openai/gpt-4o-mini');
        expect(requests).toEqual([]);
    });
});

function runWithSelection(providerID: string, modelID: string, variantID: string) {
    return runAgent({
        ...baseRunOptions(),
        modelProviderSelection: { providerID, modelID, variantID },
    });
}

function baseRunOptions() {
    return {
        mode: 'plain' as const,
        useNative: false,
        command: 'run' as const,
        showHelp: false,
        showVersion: false,
    };
}

function baseChatOptions() {
    return parseArgs([]);
}

async function useTempAuthFile(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'mission-control-model-validation-auth-'));
    const authFilePath = join(directory, 'auth.json');
    vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
    return authFilePath;
}

function staleVariantDefaultGraph() {
    return {
        id: 'stale-variant-graph',
        entryNodeId: 'start',
        defaults: {
            model: {
                providerID: 'openai',
                modelID: 'gpt-4o-mini',
                variantID: 'reasoning-high',
            },
        },
        nodes: [{ id: 'start', kind: 'action' }],
        edges: [],
        rules: [],
        policies: [],
    };
}

function staleVariantFallbackGraph() {
    return {
        id: 'stale-variant-fallback-graph',
        entryNodeId: 'start',
        defaults: {
            model: {
                providerID: 'openai',
                modelID: 'gpt-5',
                variantID: 'reasoning-high',
                fallbacks: [{ providerID: 'openai', modelID: 'gpt-4o-mini', variantID: 'reasoning-high' }],
            },
        },
        nodes: [{ id: 'start', kind: 'action' }],
        edges: [],
        rules: [],
        policies: [],
    };
}
