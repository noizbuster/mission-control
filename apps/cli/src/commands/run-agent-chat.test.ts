import {
    missionControlDataDirEnvKey,
    type ProviderAdapter,
    type ProviderAuthStore,
    type ProviderTurnRequest,
    readLocalSessionReplay,
} from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import {
    createBufferedChatOutput,
    createEmptyAuthStore,
    createScriptedChatInput,
} from './run-agent-chat-test-support.js';
import { listSessionCatalogEntries } from './session-catalog.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runAgent interactive chat', () => {
    const tempDirs: string[] = [];
    let dataDir = '';

    beforeEach(async () => {
        dataDir = await tempRoot('mctrl-run-agent-chat-data-');
        vi.stubEnv(missionControlDataDirEnvKey, dataDir);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    });

    it('opens a prompt for default mctrl execution and exits after two consecutive Ctrl+C interrupts', async () => {
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs([]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'summarize the current mission' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
        });

        expect(output).toBe(chatOutput.getOutput());
        expect(output).toContain('mission-control chat');
        expect(output).toContain('provider: local');
        expect(output).toContain('model: local-echo');
        expect(output).toContain('selection: local/local-echo');
        expect(output).toContain('> ');
        expect(output).toContain('Assistant: received prompt: summarize the current mission');
        expect(output).toContain('Press Ctrl+C again to exit');
        expect(output).not.toContain('demo task started');
        expect(output).not.toContain('completed by mock sidecar');
    });

    it('keeps the exact-redacted prompt title when the active model is local/local-echo', async () => {
        const chatOutput = createBufferedChatOutput();
        const secret = 'arbitrary_stored_api_value_24680';
        const secretPrompt = `summarize ${secret}`;
        const providerRequests: ProviderTurnRequest[] = [];

        await runAgent(parseArgs([]), {
            authStore: authStoreWithApiKey(secret),
            provider: capturingTitleProvider(providerRequests),
            chatInput: createScriptedChatInput([
                { type: 'line', value: secretPrompt },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
        });

        const titleRequests = providerRequests.filter((request) => request.turnId.startsWith('title_turn_'));
        expect(titleRequests).toHaveLength(0);
        const sessionId = (await listSessionCatalogEntries()).at(0)?.sessionId;
        if (sessionId === undefined) {
            throw new Error('expected the secret prompt to materialize a durable session');
        }
        const replay = await readLocalSessionReplay({ dataDir, sessionId });
        if (replay.kind !== 'found') {
            throw new Error(`expected replay for ${sessionId}`);
        }
        expect(replay.replay.projection.sessionTree.sessionName).toBe('summarize [REDACTED_CREDENTIAL]');
        expect(replay.replay.projection.sessionTree.sessionName).not.toContain(secret);
        const durableNames = replay.replay.projection.events.flatMap((event) => {
            const sessionTree = event.sessionTree;
            return sessionTree?.kind === 'metadata' && sessionTree.name !== undefined ? [sessionTree.name] : [];
        });
        expect(durableNames.some((name) => name.includes('[REDACTED_CREDENTIAL]'))).toBe(true);
        expect(durableNames.every((name) => !name.includes(secret))).toBe(true);
    });

    it('persists the normalized first plain prompt title before starting the main turn', async () => {
        // Given: a chat without an eager session and a first plain prompt containing repeated whitespace.
        const chatOutput = createBufferedChatOutput();

        // When: the first prompt lazily materializes the durable session and runs the chat action.
        await runAgent(parseArgs([]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'Investigate   parser title initialization' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
        });
        const sessionId = (await listSessionCatalogEntries()).at(0)?.sessionId;
        if (sessionId === undefined) {
            throw new Error('expected the first prompt to materialize a durable session');
        }
        const replay = await readLocalSessionReplay({ dataDir, sessionId });
        if (replay.kind !== 'found') {
            throw new Error(`expected replay for ${sessionId}`);
        }
        const storedEvents = replay.replay.projection.events;
        const promptTitleIndex = storedEvents.findIndex(
            (event) =>
                event.type === 'session.metadata.updated' &&
                event.sessionTree?.kind === 'metadata' &&
                event.sessionTree.name === 'Investigate parser title initialization',
        );
        const mainTurnIndex = storedEvents.findIndex((event) => event.type === 'prompt.promoted');

        // Then: the prompt-derived metadata event is durable before main-turn admission begins.
        expect(promptTitleIndex).toBeGreaterThanOrEqual(0);
        expect(mainTurnIndex).toBeGreaterThan(promptTitleIndex);
        expect(storedEvents.some((event) => event.taskId?.startsWith('title_turn_') === true)).toBe(false);
    });

    it('does not exit when typed input separates Ctrl+C interrupts', async () => {
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs([]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'interrupt' },
                { type: 'interrupt', interruptedPartialInput: true },
                { type: 'line', value: 'continue after interrupted text' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
        });

        expect(output).toContain('Assistant: received prompt: continue after interrupted text');
        expect(output.match(/Press Ctrl\+C again to exit/g)).toHaveLength(3);
    });

    it('preserves Ctrl+C after a submitted terminal line as the next interrupt', async () => {
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs([]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'buffered ctrl-c test' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
        });

        expect(output).toContain('Assistant: received prompt: buffered ctrl-c test');
        expect(output).toContain('Press Ctrl+C again to exit');
        expect(output.match(/Press Ctrl\+C again to exit/g)).toHaveLength(1);
    });

    it('exits with /exit without submitting a prompt task', async () => {
        const chatOutput = createBufferedChatOutput();
        const events: AgentEvent[] = [];

        const output = await runAgent(parseArgs([]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([{ type: 'line', value: '/exit' }]),
            chatOutput: chatOutput.output,
            onRuntimeEvent: (event) => {
                events.push(event);
            },
        });

        expect(output).toContain('Exiting mission-control chat');
        expect(events.some((event) => event.type === 'task.started')).toBe(false);
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempDirs.push(path);
        return path;
    }
});

function authStoreWithApiKey(apiKey: string): ProviderAuthStore {
    const base = createEmptyAuthStore();
    return {
        ...base,
        readAuthFile: async () => ({
            ...(await base.readAuthFile()),
            credentials: {
                local: {
                    providerID: 'local',
                    type: 'apiKey',
                    apiKey,
                    createdAt: '2026-07-10T00:00:00.000Z',
                    updatedAt: '2026-07-10T00:00:00.000Z',
                },
            },
        }),
    };
}

function capturingTitleProvider(requests: ProviderTurnRequest[]): ProviderAdapter {
    return {
        async *streamTurn(request) {
            requests.push(request);
            yield {
                kind: 'response_completed',
                requestId: request.requestId,
                sequence: 1,
                message: {
                    messageId: `message_${request.turnId}`,
                    role: 'assistant',
                    content: request.turnId.startsWith('title_turn_') ? 'Safe generated title' : 'Main turn completed',
                },
                finishReason: 'stop',
            };
        },
    };
}
