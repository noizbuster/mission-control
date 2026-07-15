import type { CodingReplayStep } from '@mission-control/core';
import type { AgentEvent, AgentEventEnvelope } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { reconstructSessionTranscript } from './session-transcript-reconstruction';

const SESSION_ID = 'session_test';
const NOW = '2026-07-01T00:00:00.000Z';

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
): CodingReplayStep {
    return {
        kind: 'tool.result',
        eventId: `evt_${sequence}`,
        timestamp: NOW,
        toolCallId,
        status,
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
});
