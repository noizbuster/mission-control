import { openLocalSessionEventStore, type CodingReplayStep } from '@mission-control/core';
import type { AgentEvent, AgentEventEnvelope } from '@mission-control/protocol';
import { shouldHideToolPart } from '@mission-control/tui/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeLocalSessionEvents } from './session-test-support';
import {
    loadSessionTranscript,
    loadSessionTranscriptPartsFromStore,
    projectChildJobsOntoTranscript,
    reconstructSessionTranscript,
    reconstructSessionTranscriptParts,
} from './session-transcript-reconstruction';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SESSION_ID = 'session_test';
const NOW = '2026-07-01T00:00:00.000Z';
const hostileReplayPayload =
    '한국어 👨‍👩‍👧\ncredential sk-reconstructionraw123 OSC:\u001b]52;c;UE9D\u0007 C0:\u0001 C1:\u009b CR:\r TAB:\t DEL:\u007f BIDI:\u202e';
const persistedReplayPayload = hostileReplayPayload.replace('sk-reconstructionraw123', '[REDACTED_CREDENTIAL]');
const tempRoots: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
    tempRoots.length = 0;
});

function envelope(
    sequence: number,
    event: AgentEvent,
    overrides: Partial<AgentEventEnvelope> = {},
): AgentEventEnvelope {
    return {
        eventId: `evt_${sequence}`,
        sequence,
        createdAt: NOW,
        sessionId: SESSION_ID,
        durability: 'durable',
        event: { ...event, sessionId: SESSION_ID },
        ...overrides,
    };
}

function userPromptEvent(message: string): AgentEvent {
    return { type: 'prompt.promoted', timestamp: NOW, message };
}

function providerMessageStep(sequence: number, message: string, continuation = false): CodingReplayStep {
    return {
        kind: 'provider.message',
        eventId: `evt_${sequence}`,
        timestamp: NOW,
        messageId: `msg_${sequence}`,
        message,
        continuation,
    };
}

function providerFailureStep(sequence: number, errorMessage: string): CodingReplayStep {
    return {
        kind: 'provider.failure',
        eventId: `evt_${sequence}`,
        timestamp: NOW,
        requestId: `req_${sequence}`,
        error: { code: 'unknown', message: errorMessage, retryable: false },
    };
}

function toolCallStep(sequence: number, toolCallId: string, toolName: string): CodingReplayStep {
    return {
        kind: 'provider.tool_call',
        eventId: `evt_${sequence}`,
        timestamp: NOW,
        toolCallId,
        toolName,
    };
}

function toolResultStep(
    sequence: number,
    toolCallId: string,
    status: 'completed' | 'failed',
    error?: { readonly message: string },
    output?: string,
): CodingReplayStep {
    return {
        kind: 'tool.result',
        eventId: `evt_${sequence}`,
        timestamp: NOW,
        toolCallId,
        status,
        ...(output !== undefined ? { output } : {}),
        ...(error !== undefined ? { error: { code: 'unknown', ...error, retryable: false } } : {}),
    };
}

describe('reconstructSessionTranscript', () => {
    it('returns empty string for an empty session', () => {
        expect(reconstructSessionTranscript({ envelopes: [], codingSteps: [] })).toBe('');
    });

    it('emits a You: line for prompt.promoted events', () => {
        const envelopes = [envelope(1, userPromptEvent('hello world'))];
        const result = reconstructSessionTranscript({ envelopes, codingSteps: [] });
        expect(result).toBe('You: hello world\n');
    });

    it('renders session.finalize as the final Session <status>[: reason] line', () => {
        const envelopes = [
            envelope(1, userPromptEvent('hello')),
            envelope(2, {
                type: 'session.finalize',
                timestamp: NOW,
                message: 'Session complete',
                sessionFinalize: { status: 'complete' },
            }),
        ];
        const result = reconstructSessionTranscript({ envelopes, codingSteps: [] });
        expect(result).toBe('You: hello\nSession complete\n');
    });

    it('renders session.finalize reason when present', () => {
        const envelopes = [
            envelope(1, {
                type: 'session.finalize',
                timestamp: NOW,
                message: 'Session failed: provider error',
                sessionFinalize: { status: 'failed', reason: 'provider error' },
            }),
        ];
        const result = reconstructSessionTranscript({ envelopes, codingSteps: [] });
        expect(result).toBe('Session failed: provider error\n');
    });

    it('emits Assistant: lines for non-empty provider.message steps', () => {
        const envelopes = [
            envelope(1, userPromptEvent('hi')),
            envelope(2, { type: 'model.call.completed', timestamp: NOW }),
        ];
        const steps = [providerMessageStep(2, 'hello there', false)];
        const result = reconstructSessionTranscript({ envelopes, codingSteps: steps });
        expect(result).toBe('You: hi\nAssistant: hello there\n');
    });

    it('skips empty provider.message steps (tool-only turn markers)', () => {
        const envelopes = [
            envelope(1, { type: 'model.call.completed', timestamp: NOW }),
            envelope(2, { type: 'model.call.completed', timestamp: NOW }),
        ];
        const steps = [providerMessageStep(1, '', false), providerMessageStep(2, 'real response', false)];
        const result = reconstructSessionTranscript({ envelopes, codingSteps: steps });
        expect(result).toBe('Assistant: real response\n');
    });

    it('emits Error: lines for provider.failure steps', () => {
        const envelopes = [envelope(1, { type: 'model.call.completed', timestamp: NOW })];
        const steps = [providerFailureStep(1, 'rate limited')];
        const result = reconstructSessionTranscript({ envelopes, codingSteps: steps });
        expect(result).toBe('Error: rate limited\n');
    });

    it('emits a tool failure line for failed tool.result and omits successful ones', () => {
        const envelopes = [
            envelope(1, userPromptEvent('run a command')),
            envelope(2, { type: 'model.call.completed', timestamp: NOW }),
            envelope(3, { type: 'tool.completed', timestamp: NOW, taskId: 'call_ok' }),
            envelope(4, { type: 'model.call.completed', timestamp: NOW }),
            envelope(5, { type: 'tool.failed', timestamp: NOW, taskId: 'call_bad' }),
        ];
        const steps = [
            toolCallStep(2, 'call_ok', 'command.run'),
            toolResultStep(3, 'call_ok', 'completed'),
            toolCallStep(4, 'call_bad', 'file.patch'),
            toolResultStep(5, 'call_bad', 'failed', { message: 'dirty working tree' }),
        ];
        const result = reconstructSessionTranscript({ envelopes, codingSteps: steps });
        // Successful tool omitted (collapsed view); failed tool surfaces with resolved name.
        expect(result).toBe('You: run a command\nfile.patch failed: dirty working tree\n');
    });

    it('renders a full conversation turn in order', () => {
        const envelopes = [
            envelope(1, userPromptEvent('fix the bug')),
            envelope(2, { type: 'model.call.completed', timestamp: NOW }),
            envelope(3, { type: 'tool.failed', timestamp: NOW, taskId: 'tc' }),
            envelope(4, { type: 'model.call.completed', timestamp: NOW }),
        ];
        const steps = [
            toolCallStep(2, 'tc', 'file.patch'),
            toolResultStep(3, 'tc', 'failed', { message: 'not found' }),
            providerMessageStep(4, 'the fix is applied', false),
        ];
        const result = reconstructSessionTranscript({ envelopes, codingSteps: steps });
        expect(result).toBe('You: fix the bug\nfile.patch failed: not found\nAssistant: the fix is applied\n');
    });

    it('does not emit You: for prompt.admitted (pre-promotion duplicate)', () => {
        const envelopes = [
            envelope(1, { type: 'prompt.admitted', timestamp: NOW, message: 'queued' }),
            envelope(2, userPromptEvent('queued')),
        ];
        const result = reconstructSessionTranscript({ envelopes, codingSteps: [] });
        expect(result).toBe('You: queued\n');
    });

    it('ignores envelopes with no matching step and no prompt event', () => {
        const envelopes = [
            envelope(1, { type: 'session.started', timestamp: NOW }),
            envelope(2, { type: 'run.started', timestamp: NOW }),
        ];
        const result = reconstructSessionTranscript({ envelopes, codingSteps: [] });
        expect(result).toBe('');
    });

    it('reconstructs raw prompt, provider, error, and tool bytes in durable order without mutating replay data', () => {
        // Given
        const envelopes = [
            envelope(1, userPromptEvent(hostileReplayPayload)),
            envelope(2, { type: 'model.call.completed', timestamp: NOW }),
            envelope(3, { type: 'model.call.completed', timestamp: NOW }),
            envelope(4, { type: 'model.call.completed', timestamp: NOW }),
            envelope(5, { type: 'tool.failed', timestamp: NOW, taskId: 'raw-tool-call-id' }),
        ];
        const steps = [
            providerMessageStep(2, hostileReplayPayload),
            providerFailureStep(3, hostileReplayPayload),
            toolCallStep(4, 'raw-tool-call-id', hostileReplayPayload),
            toolResultStep(5, 'raw-tool-call-id', 'failed', { message: hostileReplayPayload }),
        ];

        // When
        const result = reconstructSessionTranscript({ envelopes, codingSteps: steps });

        // Then
        expect(result).toBe(
            `You: ${hostileReplayPayload}\nAssistant: ${hostileReplayPayload}\nError: ${hostileReplayPayload}\n${hostileReplayPayload} failed: ${hostileReplayPayload}\n`,
        );
        expect(envelopes[0]?.event.message).toBe(hostileReplayPayload);
        expect(steps[0]).toEqual(providerMessageStep(2, hostileReplayPayload));
        expect(steps[2]).toEqual(toolCallStep(4, 'raw-tool-call-id', hostileReplayPayload));
    });

    it('preserves replay bytes after persistence-time credential redaction in loadSessionTranscript', async () => {
        // Given
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-session-transcript-display-'));
        tempRoots.push(dataDir);
        const sessionId = 'session_terminal_display_replay';
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await writeLocalSessionEvents({
            dataDir,
            sessionId,
            events: [{ ...userPromptEvent(hostileReplayPayload), sessionId }],
        });

        // When
        const transcript = await loadSessionTranscript(sessionId);

        // Then
        expect(transcript).toBe(`You: ${persistedReplayPayload}\n`);
    });

    it('reconstructs from the attached store rather than the default data directory', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-session-transcript-attached-'));
        tempRoots.push(dataDir);
        const sessionId = 'session_attached_store_replay';
        await writeLocalSessionEvents({
            dataDir,
            sessionId,
            events: [
                { ...userPromptEvent('remember this'), sessionId },
                {
                    type: 'model.call.completed',
                    timestamp: NOW,
                    sessionId,
                    abg: {
                        graphId: 'graph_attached',
                        nodeId: 'assistant',
                        nodeKind: 'llm',
                        emit: { type: 'llm.turn.completed', payload: { text: 'I remember.' } },
                    },
                },
            ],
        });
        const store = await openLocalSessionEventStore({ dataDir, sessionId });
        try {
            const transcript = await loadSessionTranscriptPartsFromStore(store, sessionId);

            expect(transcript.outputText).toBe('You: remember this\nAssistant: I remember.\n');
            expect(transcript.parts).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ type: 'user', text: 'remember this' }),
                    expect.objectContaining({ type: 'assistant', text: 'I remember.' }),
                ]),
            );
        } finally {
            await store.close();
        }
    });
});

describe('reconstructSessionTranscriptParts', () => {
    it('returns empty parts and text for an empty session', () => {
        const result = reconstructSessionTranscriptParts({ envelopes: [], codingSteps: [] });
        expect(result.parts).toEqual([]);
        expect(result.outputText).toBe('');
    });

    it('produces typed user, assistant, tool, and error parts in order', () => {
        const envelopes = [
            envelope(1, userPromptEvent('look at this')),
            envelope(2, { type: 'model.call.completed', timestamp: NOW }),
            envelope(3, { type: 'tool.completed', timestamp: NOW }),
            envelope(4, { type: 'model.call.completed', timestamp: NOW }),
            envelope(5, { type: 'model.call.failed', timestamp: NOW }),
        ];
        const steps: CodingReplayStep[] = [
            providerMessageStep(2, 'I will search'),
            toolCallStep(3, 'call_grep', 'grep'),
            toolResultStep(3, 'call_grep', 'completed', undefined, 'result line'),
            providerMessageStep(4, 'Here is the answer'),
            providerFailureStep(5, 'bad model'),
        ];
        const result = reconstructSessionTranscriptParts({ envelopes, codingSteps: steps });

        expect(result.parts).toHaveLength(5);
        expect(result.parts[0]).toEqual(
            expect.objectContaining({ type: 'user', text: 'look at this' }),
        );
        expect(result.parts[1]).toEqual(
            expect.objectContaining({ type: 'assistant', text: 'I will search', status: 'completed' }),
        );
        expect(result.parts[2]).toEqual(
            expect.objectContaining({
                type: 'inline-tool',
                toolCallId: 'call_grep',
                toolName: 'grep',
                status: 'completed',
                text: 'result line',
            }),
        );
        expect(result.parts[3]).toEqual(
            expect.objectContaining({ type: 'assistant', text: 'Here is the answer', status: 'completed' }),
        );
        expect(result.parts[4]).toEqual(
            expect.objectContaining({ type: 'error', status: 'failed', text: 'bad model' }),
        );
    });

    it('includes failed tool results as typed parts', () => {
        const envelopes = [
            envelope(1, userPromptEvent('try the tool')),
            envelope(2, { type: 'tool.failed', timestamp: NOW }),
        ];
        const steps: CodingReplayStep[] = [
            toolCallStep(2, 'call_fail', 'file.patch'),
            toolResultStep(2, 'call_fail', 'failed', { message: 'patch rejected' }),
        ];
        const result = reconstructSessionTranscriptParts({ envelopes, codingSteps: steps });

        expect(result.parts).toHaveLength(2);
        expect(result.parts[1]).toEqual(
            expect.objectContaining({
                type: 'inline-tool',
                toolName: 'file.patch',
                status: 'failed',
                error: 'patch rejected',
            }),
        );
    });

    it('also returns legacy outputText alongside typed parts', () => {
        const envelopes = [
            envelope(1, userPromptEvent('hello')),
            envelope(2, { type: 'model.call.completed', timestamp: NOW }),
        ];
        const steps: CodingReplayStep[] = [providerMessageStep(2, 'world')];
        const result = reconstructSessionTranscriptParts({ envelopes, codingSteps: steps });

        expect(result.outputText).toContain('You: hello');
        expect(result.outputText).toContain('Assistant: world');
    });

    it('stamps the owning assistant messageId on tool parts so shouldHideToolPart can fold past turns', () => {
        const envelopes = [
            envelope(1, userPromptEvent('do things')),
            envelope(2, { type: 'model.call.completed', timestamp: NOW }),
            envelope(3, { type: 'tool.completed', timestamp: NOW }),
            envelope(4, { type: 'model.call.completed', timestamp: NOW }),
            envelope(5, { type: 'tool.completed', timestamp: NOW }),
            envelope(6, { type: 'model.call.completed', timestamp: NOW }),
        ];
        const steps: CodingReplayStep[] = [
            providerMessageStep(2, 'first turn'),
            toolCallStep(3, 'call_one', 'grep'),
            toolResultStep(3, 'call_one', 'completed', undefined, 'one'),
            providerMessageStep(4, 'second turn'),
            toolCallStep(5, 'call_two', 'read'),
            toolResultStep(5, 'call_two', 'completed', undefined, 'two'),
            providerMessageStep(6, 'third turn'),
        ];
        const result = reconstructSessionTranscriptParts({ envelopes, codingSteps: steps });

        const toolParts = result.parts.filter((part) => part.type === 'inline-tool');
        expect(toolParts).toHaveLength(2);
        // First tool belongs to msg_2 (first assistant turn).
        expect('messageId' in toolParts[0]! ? toolParts[0].messageId : undefined).toBe('msg_2');
        // Second tool belongs to msg_4 (second assistant turn).
        expect('messageId' in toolParts[1]! ? toolParts[1].messageId : undefined).toBe('msg_4');

        // The last assistant part is msg_6 → activeAssistantMessageId = 'msg_6'.
        // Both tools belong to earlier turns, so shouldHideToolPart hides them.
        const lastAssistant = [...result.parts].reverse().find((part) => part.type === 'assistant');
        const activeId = 'messageId' in (lastAssistant ?? {}) ? (lastAssistant as { messageId?: string }).messageId : undefined;
        expect(activeId).toBe('msg_6');
        for (const tool of toolParts) {
            expect(shouldHideToolPart(tool, activeId)).toBe(true);
        }
    });
});

describe('projectChildJobsOntoTranscript', () => {
    it('appends durable child job yields missing from the parent event stream', () => {
        const base = reconstructSessionTranscriptParts({
            envelopes: [envelope(1, userPromptEvent('implement auth slash'))],
            codingSteps: [],
        });
        const merged = projectChildJobsOntoTranscript(base, [
            {
                jobId: 'session_child_a',
                childSessionId: 'session_child_a',
                status: 'completed',
                title: 'Map /auth slash command paths',
                output: '## Implementation map\n/auth is missing today.',
            },
            {
                jobId: 'session_child_b',
                childSessionId: 'session_child_b',
                status: 'failed',
                title: 'Broken child',
                output: 'provider aborted',
            },
        ]);

        expect(merged.parts.filter((part) => part.type === 'subagent')).toEqual([
            expect.objectContaining({
                type: 'subagent',
                title: 'Map /auth slash command paths',
                sessionId: 'session_child_a',
                status: 'completed',
                text: '## Implementation map\n/auth is missing today.',
            }),
            expect.objectContaining({
                type: 'subagent',
                title: 'Broken child',
                sessionId: 'session_child_b',
                status: 'failed',
                error: 'provider aborted',
            }),
        ]);
        expect(merged.outputText).toContain('You: implement auth slash');
        expect(merged.outputText).toContain('Subagent Map /auth slash command paths: ## Implementation map');
        expect(merged.outputText).toContain('Subagent Broken child failed: provider aborted');
    });

    it('does not duplicate child sessions already present as subagent parts', () => {
        const base = {
            parts: [
                {
                    id: 'existing',
                    type: 'subagent' as const,
                    text: 'already restored',
                    sessionId: 'session_child_a',
                    status: 'completed' as const,
                },
            ],
            outputText: 'Subagent already restored\n',
        };
        const merged = projectChildJobsOntoTranscript(base, [
            {
                jobId: 'session_child_a',
                childSessionId: 'session_child_a',
                status: 'completed',
                output: 'duplicate yield',
            },
        ]);
        expect(merged.parts).toHaveLength(1);
        expect(merged.outputText).toBe('Subagent already restored\n');
    });

    it('inserts salvaged child text before a trailing session finalize marker', () => {
        const base = {
            parts: [{ id: 'u1', type: 'user' as const, text: 'go' }],
            outputText: 'You: go\nSession aborted: interrupted by user\n',
        };
        const merged = projectChildJobsOntoTranscript(base, [
            {
                jobId: 'job_1',
                childSessionId: 'child_1',
                status: 'completed',
                title: 'Worker',
                output: 'done',
            },
        ]);
        expect(merged.outputText).toBe('You: go\nSubagent Worker: done\nSession aborted: interrupted by user\n');
    });
});
