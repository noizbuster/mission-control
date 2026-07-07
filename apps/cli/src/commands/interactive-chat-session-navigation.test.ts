import {
    openLocalSessionEventStore,
    type ProviderAdapter,
    readLocalSessionReplay,
    SessionRunOwner,
} from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection, ProviderStreamChunk } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionNavigationController } from './interactive-chat-session-navigation.js';
import { writeSessionEvents } from './session-test-support.js';
import { appendFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const selection: ModelProviderSelection = {
    providerID: 'openai',
    modelID: 'gpt-5.4',
};
const tempRoots: string[] = [];

describe('interactive chat session navigation', () => {
    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('refuses to fork a corrupt legacy session file', async () => {
        const { dataDir, sessionId } = await createCorruptSession();
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const switchSessionStore = vi.fn(async () => {
            throw new Error('switchSessionStore should not be called for corrupt sessions');
        });
        const navigation = createSessionNavigationController({
            getCurrentSessionId: () => sessionId,
            getCurrentStore: () => undefined,
            switchSessionStore,
        });

        await expect(
            navigation.forkSession({
                entryId: 'entry_root',
                modelProviderSelection: selection,
                sessionId: 'session_fork_target',
            }),
        ).rejects.toThrow(`Cannot fork corrupt session: ${sessionId}`);
        expect(switchSessionStore).not.toHaveBeenCalled();
    });

    it('refuses to clone a corrupt legacy session file', async () => {
        const { dataDir, sessionId } = await createCorruptSession();
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const switchSessionStore = vi.fn(async () => {
            throw new Error('switchSessionStore should not be called for corrupt sessions');
        });
        const navigation = createSessionNavigationController({
            getCurrentSessionId: () => sessionId,
            getCurrentStore: () => undefined,
            switchSessionStore,
        });

        await expect(
            navigation.cloneSession({
                modelProviderSelection: selection,
                sessionId: 'session_clone_target',
            }),
        ).rejects.toThrow(`Cannot clone corrupt session: ${sessionId}`);
        expect(switchSessionStore).not.toHaveBeenCalled();
    });

    it('selects a branch from database state without touching a corrupt legacy JSONL artifact', async () => {
        const dataDir = await tempRoot('mctrl-session-navigation-corrupt-');
        const sessionId = 'session_corrupt_source';
        await writeSessionEvents({
            dataDir,
            sessionId,
            events: [sessionEvent(sessionId, 'task.completed', 'root task', { kind: 'entry', entryId: 'entry_root' })],
        });
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const store = await openLocalSessionEventStore({ dataDir, sessionId });
        await appendFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), '{"corrupt": true}\n', 'utf8');
        const before = await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8');
        const navigation = createSessionNavigationController({
            getCurrentSessionId: () => sessionId,
            getCurrentStore: () => store,
            switchSessionStore: async () => {
                throw new Error('switchSessionStore should not be called for selectBranch');
            },
        });

        try {
            await expect(
                navigation.selectBranch({
                    entryId: 'entry_root',
                    modelProviderSelection: selection,
                }),
            ).resolves.toMatchObject({ message: expect.stringContaining('Active branch: entry_root') });
            const after = await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8');
            expect(after).toBe(before);
        } finally {
            await store.close();
        }
    });

    it('filters copied control-plane events out of forked and cloned sessions', async () => {
        const dataDir = await tempRoot('mctrl-session-navigation-copy-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const sourceSessionId = 'session_navigation_source';
        await writeSessionEvents({
            dataDir,
            sessionId: sourceSessionId,
            events: [
                sessionEvent(sourceSessionId, 'session.started', 'seed source'),
                sessionEvent(sourceSessionId, 'prompt.admitted', 'queued prompt'),
                sessionEvent(sourceSessionId, 'task.completed', 'root prompt', {
                    kind: 'entry',
                    entryId: 'entry_root',
                }),
                sessionEvent(sourceSessionId, 'model.call.completed', 'tool requested', undefined, {
                    kind: 'tool_call_completed',
                    requestId: 'request_seed',
                    sequence: 0,
                    toolCall: {
                        toolCallId: 'seed_patch_call',
                        toolName: 'file.patch',
                        argumentsJson: '{"patch":"seed"}',
                    },
                }),
                sessionEvent(sourceSessionId, 'run.blocked', 'waiting for approval', undefined, undefined, {
                    command: 'run',
                    state: 'blocked_on_approval',
                    runId: 'run_seed',
                    reason: 'waiting for approval',
                    toolCallId: 'seed_patch_call',
                }),
                approvalUpdatedEvent(sourceSessionId),
                permissionRepliedEvent(sourceSessionId),
                toolCompletedEvent(sourceSessionId),
            ],
        });
        const navigation = createSessionNavigationController({
            getCurrentSessionId: () => sourceSessionId,
            getCurrentStore: () => undefined,
            switchSessionStore: async (sessionId) => {
                const store = await openLocalSessionEventStore({ dataDir, sessionId });
                await store.close();
                return store;
            },
        });

        await navigation.forkSession({
            entryId: 'entry_root',
            modelProviderSelection: selection,
            sessionId: 'session_navigation_fork',
        });
        await navigation.cloneSession({
            modelProviderSelection: selection,
            sessionId: 'session_navigation_clone',
        });

        const forkProjection = await readProjection(dataDir, 'session_navigation_fork');
        const cloneProjection = await readProjection(dataDir, 'session_navigation_clone');

        expect(eventTypes(forkProjection)).toEqual(
            expect.not.arrayContaining(['run.blocked', 'approval.updated', 'permission.replied', 'tool.completed']),
        );
        expect(eventTypes(cloneProjection)).toEqual(
            expect.not.arrayContaining(['run.blocked', 'approval.updated', 'permission.replied', 'tool.completed']),
        );
        expect(eventTypes(forkProjection)).toEqual(
            expect.arrayContaining(['prompt.admitted', 'task.completed', 'session.forked']),
        );
        expect(eventTypes(cloneProjection)).toEqual(
            expect.arrayContaining(['prompt.admitted', 'model.call.completed', 'session.cloned']),
        );
    });

    it('clones from a SQLite-native source session without requiring a legacy JSONL log', async () => {
        const dataDir = await tempRoot('mctrl-session-navigation-sqlite-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const sourceSessionId = 'session_navigation_sqlite_source';
        await writeLocalSessionEvents({
            dataDir,
            sessionId: sourceSessionId,
            events: [
                sessionEvent(sourceSessionId, 'session.started', 'seed source'),
                sessionEvent(sourceSessionId, 'prompt.admitted', 'queued prompt'),
                sessionEvent(sourceSessionId, 'task.completed', 'root prompt', {
                    kind: 'entry',
                    entryId: 'entry_root',
                }),
            ],
        });
        const navigation = createSessionNavigationController({
            getCurrentSessionId: () => sourceSessionId,
            getCurrentStore: () => undefined,
            switchSessionStore: async (sessionId) => {
                const store = await openLocalSessionEventStore({ dataDir, sessionId });
                await store.close();
                return store;
            },
        });

        await navigation.cloneSession({
            modelProviderSelection: selection,
            sessionId: 'session_navigation_sqlite_clone',
        });

        const cloneProjection = await readProjection(dataDir, 'session_navigation_sqlite_clone');
        expect(eventTypes(cloneProjection)).toEqual(
            expect.arrayContaining(['session.started', 'prompt.admitted', 'task.completed', 'session.cloned']),
        );
        expect(cloneProjection.sessionTree.cloneSource).toMatchObject({
            sessionId: sourceSessionId,
            entryId: 'entry_root',
        });
        await expect(readdir(join(dataDir, 'sessions'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('does not preserve copied blocked run state when a cloned session is resumed', async () => {
        const dataDir = await tempRoot('mctrl-session-navigation-resume-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const sourceSessionId = 'session_navigation_source';
        await writeSessionEvents({
            dataDir,
            sessionId: sourceSessionId,
            events: [
                sessionEvent(sourceSessionId, 'session.started', 'seed source'),
                sessionEvent(sourceSessionId, 'task.completed', 'root prompt', {
                    kind: 'entry',
                    entryId: 'entry_root',
                }),
                blockedRunEvent(sourceSessionId),
                approvalUpdatedEvent(sourceSessionId),
                toolCompletedEvent(sourceSessionId),
            ],
        });
        const navigation = createSessionNavigationController({
            getCurrentSessionId: () => sourceSessionId,
            getCurrentStore: () => undefined,
            switchSessionStore: async (sessionId) => {
                const store = await openLocalSessionEventStore({ dataDir, sessionId });
                await store.close();
                return store;
            },
        });

        await navigation.cloneSession({
            modelProviderSelection: selection,
            sessionId: 'session_navigation_clone',
        });

        const store = await openLocalSessionEventStore({ dataDir, sessionId: 'session_navigation_clone' });
        try {
            const owner = new SessionRunOwner({
                sessionId: 'session_navigation_clone',
                store,
                provider: idleProvider(),
                modelProviderSelection: selection,
                runProviderTurn: async () => ({ status: 'completed' as const }),
            });
            const receipt = await owner.resume();
            expect(receipt).toMatchObject({
                sessionId: 'session_navigation_clone',
                status: 'completed',
            });
            expect(receipt.status).not.toBe('blocked_on_approval');
            expect(receipt.toolCallId).toBeUndefined();
            expect(receipt.runId).not.toBe('run_seed');
        } finally {
            await store.close();
        }
    });

    it('renameSession appends a metadata event whose name the catalog projection reads back', async () => {
        const dataDir = await tempRoot('mctrl-session-navigation-rename-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const sessionId = 'session_rename_target';
        await writeSessionEvents({
            dataDir,
            sessionId,
            events: [
                sessionEvent(sessionId, 'session.started', 'seed'),
                sessionEvent(sessionId, 'task.completed', 'root', { kind: 'entry', entryId: 'entry_root' }),
            ],
        });
        const store = await openLocalSessionEventStore({ dataDir, sessionId });
        const observed: AgentEvent[] = [];
        const navigation = createSessionNavigationController({
            getCurrentSessionId: () => sessionId,
            getCurrentStore: () => store,
            switchSessionStore: async () => {
                throw new Error('switchSessionStore should not be called for renameSession');
            },
            observeStoredEvent: (event) => {
                observed.push(event);
            },
        });

        try {
            const result = await navigation.renameSession({
                name: 'investigate parser',
                modelProviderSelection: selection,
            });

            expect(result.message).toContain('investigate parser');
            expect(observed.length).toBe(1);
            expect(observed[0]?.type).toBe('session.metadata.updated');
            expect(observed[0]?.sessionTree).toEqual({ kind: 'metadata', name: 'investigate parser' });

            const projection = await readProjection(dataDir, sessionId);
            expect(projection.sessionTree.sessionName).toBe('investigate parser');
        } finally {
            await store.close();
        }
    });

    it('renameSession refuses when no durable session is active', async () => {
        const navigation = createSessionNavigationController({
            getCurrentSessionId: () => undefined,
            getCurrentStore: () => undefined,
            switchSessionStore: async () => {
                throw new Error('switchSessionStore should not be called');
            },
        });

        await expect(navigation.renameSession({ name: 'orphan', modelProviderSelection: selection })).rejects.toThrow(
            'No durable session is active',
        );
    });
});

async function createCorruptSession(): Promise<{ readonly dataDir: string; readonly sessionId: string }> {
    const dataDir = await tempRoot('mctrl-session-navigation-corrupt-');
    const sessionId = 'session_corrupt_source';
    await writeSessionEvents({
        dataDir,
        sessionId,
        events: [sessionEvent(sessionId, 'task.completed', 'root task', { kind: 'entry', entryId: 'entry_root' })],
    });
    await appendFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), '{"corrupt": true}\n', 'utf8');
    return { dataDir, sessionId };
}

async function readProjection(dataDir: string, sessionId: string) {
    const replay = await readLocalSessionReplay({ dataDir, sessionId });
    if (replay.kind !== 'found') {
        throw new Error(`expected replay for ${sessionId}`);
    }
    return replay.replay.projection;
}

async function writeLocalSessionEvents(input: {
    readonly dataDir: string;
    readonly sessionId: string;
    readonly events: readonly AgentEvent[];
}): Promise<void> {
    const store = await openLocalSessionEventStore({
        dataDir: input.dataDir,
        sessionId: input.sessionId,
        now: () => '2026-06-05T10:00:00.000Z',
        createEventId: (event, sequence) => `${input.sessionId}_${sequence}_${event.type.replaceAll('.', '_')}`,
    });
    try {
        for (const event of input.events) {
            await store.append(event);
        }
    } finally {
        await store.close();
    }
}

function eventTypes(projection: Awaited<ReturnType<typeof readProjection>>): readonly string[] {
    return projection.events.map((event) => event.type);
}

function idleProvider(): ProviderAdapter {
    return {
        async *streamTurn() {
            yield {
                kind: 'response_completed',
                requestId: 'request_idle',
                sequence: 0,
                message: {
                    messageId: 'message_idle',
                    role: 'assistant',
                    content: 'idle',
                },
                finishReason: 'stop',
            };
        },
    };
}

function blockedRunEvent(sessionId: string): AgentEvent {
    return sessionEvent(sessionId, 'run.blocked', 'waiting for approval', undefined, undefined, {
        command: 'run',
        state: 'blocked_on_approval',
        runId: 'run_seed',
        reason: 'waiting for approval',
        toolCallId: 'seed_patch_call',
    });
}

function approvalUpdatedEvent(sessionId: string): AgentEvent {
    return {
        type: 'approval.updated',
        timestamp: '2026-06-05T10:00:00.000Z',
        sessionId,
        message: 'approval granted',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: selection,
        approvalRecord: {
            approvalId: 'approval_seed_patch_call',
            requestId: 'approval_seed_patch_call',
            state: 'approved',
            requestedAt: '2026-06-05T10:00:00.000Z',
            decidedAt: '2026-06-05T10:00:00.000Z',
            reason: 'approved externally',
            subject: { kind: 'tool', id: 'seed_patch_call' },
            policyDecision: 'requires_approval',
        },
    };
}

function permissionRepliedEvent(sessionId: string): AgentEvent {
    return {
        type: 'permission.replied',
        timestamp: '2026-06-05T10:00:00.000Z',
        sessionId,
        message: 'permission allow',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: selection,
        permissionReply: {
            approvalId: 'approval_seed_patch_call',
            reply: 'once',
            reason: 'approved',
        },
    };
}

function toolCompletedEvent(sessionId: string): AgentEvent {
    return {
        type: 'tool.completed',
        timestamp: '2026-06-05T10:00:00.000Z',
        sessionId,
        taskId: 'seed_patch_call',
        message: 'tool completed',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: selection,
        toolResult: {
            toolCallId: 'seed_patch_call',
            status: 'completed',
            output: 'applied patch',
        },
    };
}

function sessionEvent(
    sessionId: string,
    type: AgentEvent['type'],
    message: string,
    sessionTree?: AgentEvent['sessionTree'],
    providerStreamChunk?: ProviderStreamChunk,
    run?: AgentEvent['run'],
): AgentEvent {
    return {
        type,
        timestamp: '2026-06-05T10:00:00.000Z',
        sessionId,
        message,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: selection,
        ...(sessionTree !== undefined ? { sessionTree } : {}),
        ...(providerStreamChunk !== undefined ? { providerStreamChunk } : {}),
        ...(run !== undefined ? { run } : {}),
    };
}

async function tempRoot(prefix: string): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(dataDir);
    return dataDir;
}
