import { createDeterministicProvider, projectSessionReplay } from '@mission-control/core';
import { type AgentEvent, type AgentEventEnvelope } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
import { runAgent } from './run-agent';
import { createBufferedChatOutput, createEmptyAuthStore, createScriptedChatInput } from './run-agent-chat-test-support';
import { replayedEvents } from './session-replay-test-support';
import { writeSessionEvents } from './session-test-support';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runAgent interactive coding agent UX', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('navigates durable sessions with tree, branch, fork, clone, and list commands', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-chat-data-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await writeSessionEvents({
            dataDir,
            sessionId: 'session_navigation_source',
            events: [
                sessionEvent('session_navigation_source', 'session.started', 'seeded navigation source'),
                sessionEvent('session_navigation_source', 'task.completed', 'root prompt', {
                    kind: 'entry',
                    entryId: 'entry_root',
                }),
                sessionEvent('session_navigation_source', 'task.completed', 'branch reply', {
                    kind: 'entry',
                    entryId: 'entry_branch',
                    parentEntryId: 'entry_root',
                    active: true,
                }),
            ],
        });
        const chatOutput = createBufferedChatOutput();

        // When
        const output = await runAgent(parseArgs(['--session', 'session_navigation_source']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/tree' },
                { type: 'line', value: '/branch entry_root' },
                { type: 'line', value: '/fork entry_root session_navigation_fork' },
                { type: 'line', value: '/clone session_navigation_clone' },
                { type: 'line', value: '/sessions' },
                { type: 'line', value: '/session session_navigation_source' },
                { type: 'line', value: '/exit' },
            ]),
            chatOutput: chatOutput.output,
            provider: createDeterministicProvider([]),
        });
        const forkReplay = await replayProjection('session_navigation_fork');
        const cloneReplay = await replayProjection('session_navigation_clone');
        const sourceReplay = await replayProjection('session_navigation_source');

        // Then
        expect(output).toContain('Session tree: session_navigation_source');
        expect(output).toContain('*     entry_branch branch reply');
        expect(output).toContain('Active branch: entry_root');
        expect(output).toContain('Forked session: session_navigation_fork from entry_root');
        expect(output).toContain('Cloned session: session_navigation_clone');
        expect(output).toContain('* session_navigation_clone');
        expect(output).toContain('Switched to session: session_navigation_source');
        expect(forkReplay.snapshot.sessionId).toBe('session_navigation_fork');
        expect(forkReplay.snapshot.status).toBe('idle');
        expect(forkReplay.sessionTree.forkSource).toEqual({
            sessionId: 'session_navigation_source',
            entryId: 'entry_root',
        });
        expect(forkReplay.sessionTree.activeLeafId).toBe('entry_root');
        expect(cloneReplay.sessionTree.cloneSource).toEqual({
            sessionId: 'session_navigation_fork',
            entryId: 'entry_root',
        });
        expect(cloneReplay.snapshot.status).toBe('idle');
        expect(sourceReplay.snapshot.sessionId).toBe('session_navigation_source');
        expect(sourceReplay.sessionTree.activeLeafId).toBe('entry_root');
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempRoots.push(path);
        return path;
    }
});

async function replayProjection(sessionId: string): Promise<ReturnType<typeof projectSessionReplay>> {
    const events = await replayedEvents(sessionId);
    return projectSessionReplay({
        sessionId,
        envelopes: events.map((event, index): AgentEventEnvelope => replayEnvelope(event, index)),
    });
}

function replayEnvelope(event: AgentEvent, sequence: number): AgentEventEnvelope {
    return {
        eventId: `event_${sequence}`,
        sequence,
        createdAt: event.timestamp,
        sessionId: event.sessionId ?? 'session_missing',
        durability: 'durable',
        event,
    };
}

function sessionEvent(
    sessionId: string,
    type: AgentEvent['type'],
    message: string,
    sessionTree?: AgentEvent['sessionTree'],
): AgentEvent {
    return {
        type,
        timestamp: '2026-06-13T01:00:00.000Z',
        sessionId,
        message,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: {
            providerID: 'local',
            modelID: 'local-echo',
        },
        ...(sessionTree !== undefined ? { sessionTree } : {}),
    };
}
