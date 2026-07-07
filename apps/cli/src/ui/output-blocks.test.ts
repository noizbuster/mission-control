import type { AgentEvent } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createBlockAccumulator, foldEvents } from './output-blocks.js';

const TS = '2026-07-05T00:00:00.000Z';

function event(partial: Partial<AgentEvent> & { type: AgentEvent['type'] }): AgentEvent {
    return { timestamp: TS, ...partial } as AgentEvent;
}

function textDelta(requestId: string, sequence: number, delta: string): AgentEvent {
    return event({
        type: 'task.progress',
        providerStreamChunk: { kind: 'text_delta', requestId, sequence, delta },
    });
}

function reasoningDelta(requestId: string, sequence: number, delta: string): AgentEvent {
    return event({
        type: 'task.progress',
        providerStreamChunk: { kind: 'reasoning_delta', requestId, sequence, delta },
    });
}

function responseCompleted(requestId: string, sequence: number, content: string, reasoning?: string): AgentEvent {
    return event({
        type: 'task.progress',
        providerStreamChunk: {
            kind: 'response_completed',
            requestId,
            sequence,
            message: { messageId: 'm1', role: 'assistant', content, ...(reasoning !== undefined ? { reasoning } : {}) },
            finishReason: 'stop',
        },
    });
}

function reasoningCompleted(requestId: string, sequence: number, text: string): AgentEvent {
    return event({
        type: 'task.progress',
        providerStreamChunk: { kind: 'reasoning_completed', requestId, sequence, text },
    });
}

function toolCallCompleted(toolCallId: string, toolName: string, sequence: number, argumentsJson = '{}'): AgentEvent {
    return event({
        type: 'task.progress',
        providerStreamChunk: {
            kind: 'tool_call_completed',
            requestId: 'req-tool',
            sequence,
            toolCall: { toolCallId, toolName, argumentsJson },
        },
    });
}

function toolResultEvent(toolCallId: string, status: 'completed' | 'failed', output?: string): AgentEvent {
    return event({
        type: status === 'completed' ? 'tool.completed' : 'tool.failed',
        toolResult: { toolCallId, status, ...(output !== undefined ? { output } : {}) },
    });
}

describe('foldEvents — batch fold rules', () => {
    it('accumulates text_delta by requestId and flushes assistant-text on response_completed (authoritative content)', () => {
        const blocks = foldEvents([
            textDelta('r1', 1, 'Hel'),
            textDelta('r1', 2, 'lo '),
            textDelta('r1', 3, 'world'),
            responseCompleted('r1', 4, 'Hello world'),
        ]);
        const text = blocks.filter((b) => b.kind === 'assistant-text');
        expect(text).toHaveLength(1);
        expect(text[0]).toEqual({ kind: 'assistant-text', text: 'Hello world' });
    });

    it('prefers response_completed.message.content over accumulated deltas when they diverge', () => {
        const blocks = foldEvents([textDelta('r1', 1, 'partial'), responseCompleted('r1', 2, 'authoritative final')]);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toEqual({ kind: 'assistant-text', text: 'authoritative final' });
    });

    it('joins tool_call_completed with matching toolResult into a single tool block', () => {
        const blocks = foldEvents([
            toolCallCompleted('tc1', 'repo.read', 1, '{"path":"a"}'),
            toolResultEvent('tc1', 'completed', 'file contents'),
        ]);
        const tools = blocks.filter((b) => b.kind === 'tool');
        expect(tools).toHaveLength(1);
        expect(tools[0]).toMatchObject({
            kind: 'tool',
            toolCallId: 'tc1',
            toolName: 'repo.read',
            argumentsJson: '{"path":"a"}',
            status: 'completed',
            output: 'file contents',
        });
    });

    it('marks a failed toolResult as failed status with error payload', () => {
        const blocks = foldEvents([
            toolCallCompleted('tc1', 'bash.run', 1),
            event({
                type: 'tool.failed',
                toolResult: {
                    toolCallId: 'tc1',
                    status: 'failed',
                    error: { code: 'tool_failed', message: 'boom', retryable: false },
                },
            }),
        ]);
        const tools = blocks.filter((b) => b.kind === 'tool');
        expect(tools).toHaveLength(1);
        expect(tools[0]).toMatchObject({ kind: 'tool', toolCallId: 'tc1', status: 'failed' });
    });

    it('accumulates reasoning_delta and flushes on reasoning_completed', () => {
        const blocks = foldEvents([
            reasoningDelta('r1', 1, 'think '),
            reasoningDelta('r1', 2, 'step'),
            reasoningCompleted('r1', 3, 'think step'),
        ]);
        const reasoning = blocks.filter((b) => b.kind === 'reasoning');
        expect(reasoning).toHaveLength(1);
        expect(reasoning[0]).toEqual({ kind: 'reasoning', text: 'think step' });
    });

    it('emits a session-header from run.started carrying modelProviderSelection', () => {
        const blocks = foldEvents([
            event({
                type: 'run.started',
                modelProviderSelection: { providerID: 'openai', modelID: 'gpt-5' },
            }),
        ]);
        const headers = blocks.filter((b) => b.kind === 'session-header');
        expect(headers).toHaveLength(1);
        expect(headers[0]).toEqual({ kind: 'session-header', providerID: 'openai', modelID: 'gpt-5' });
    });

    it('includes variantID on session-header when present', () => {
        const blocks = foldEvents([
            event({
                type: 'run.started',
                modelProviderSelection: { providerID: 'openai', modelID: 'gpt-5', variantID: 'reasoning-high' },
            }),
        ]);
        const header = blocks.find((b) => b.kind === 'session-header');
        expect(header).toEqual({
            kind: 'session-header',
            providerID: 'openai',
            modelID: 'gpt-5',
            variantID: 'reasoning-high',
        });
    });

    it('emits a session-header from task.started as well', () => {
        const blocks = foldEvents([
            event({
                type: 'task.started',
                modelProviderSelection: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
            }),
        ]);
        expect(blocks.some((b) => b.kind === 'session-header')).toBe(true);
    });

    it('emits only ONE session-header across multiple run.started events (first wins)', () => {
        const blocks = foldEvents([
            event({ type: 'run.started', modelProviderSelection: { providerID: 'openai', modelID: 'gpt-5' } }),
            event({ type: 'run.started', modelProviderSelection: { providerID: 'anthropic', modelID: 'claude' } }),
        ]);
        const headers = blocks.filter((b) => b.kind === 'session-header');
        expect(headers).toHaveLength(1);
        expect(headers[0]).toMatchObject({ providerID: 'openai' });
    });

    it('emits an error block from a response_failed provider chunk', () => {
        const blocks = foldEvents([
            event({
                type: 'task.progress',
                providerStreamChunk: {
                    kind: 'response_failed',
                    requestId: 'r1',
                    sequence: 1,
                    error: { code: 'provider_auth_failed', message: 'bad key', retryable: false },
                },
            }),
        ]);
        const errors = blocks.filter((b) => b.kind === 'error');
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ kind: 'error', message: expect.stringContaining('bad key') });
    });

    it('emits an error block from a task.failed event', () => {
        const blocks = foldEvents([event({ type: 'task.failed', message: 'task blew up' })]);
        const errors = blocks.filter((b) => b.kind === 'error');
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ kind: 'error', message: expect.stringContaining('task blew up') });
    });

    it('emits an error block from a run.failed event', () => {
        const blocks = foldEvents([event({ type: 'run.failed', message: 'run failed' })]);
        expect(blocks.some((b) => b.kind === 'error' && b.message.includes('run failed'))).toBe(true);
    });

    it('emits an error block from a tool.failed event without a toolResult body', () => {
        const blocks = foldEvents([event({ type: 'tool.failed', message: 'tool crashed' })]);
        expect(blocks.some((b) => b.kind === 'error' && b.message.includes('tool crashed'))).toBe(true);
    });

    it('preserves arrival order across mixed block kinds', () => {
        const blocks = foldEvents([
            event({ type: 'run.started', modelProviderSelection: { providerID: 'openai', modelID: 'gpt-5' } }),
            responseCompleted('r1', 2, 'answer'),
            toolCallCompleted('tc1', 'repo.read', 3),
            toolResultEvent('tc1', 'completed', 'out'),
        ]);
        expect(blocks.map((b) => b.kind)).toEqual(['session-header', 'assistant-text', 'tool']);
    });
});

describe('foldEvents — does not mutate input', () => {
    it('leaves the input array length and element identity unchanged', () => {
        const original = [textDelta('r1', 1, 'a'), responseCompleted('r1', 2, 'a')];
        const snapshot = original.map((e) => ({ ...e }));
        foldEvents(original);
        expect(original).toHaveLength(snapshot.length);
        expect(original.every((e, i) => e === snapshot[i] || JSON.stringify(e) === JSON.stringify(snapshot[i]))).toBe(
            true,
        );
    });
});

describe('createBlockAccumulator — streaming', () => {
    it('returns only newly-completed blocks from consume (deltas do not emit until close)', () => {
        const acc = createBlockAccumulator();
        expect(acc.consume(textDelta('r1', 1, 'Hel'))).toEqual([]);
        expect(acc.consume(textDelta('r1', 2, 'lo'))).toEqual([]);
        const closed = acc.consume(responseCompleted('r1', 3, 'Hello'));
        expect(closed).toHaveLength(1);
        expect(closed[0]).toEqual({ kind: 'assistant-text', text: 'Hello' });
        expect(acc.flush()).toEqual([]);
    });

    it('flush closes an unpaired tool_call_completed as pending', () => {
        const acc = createBlockAccumulator();
        expect(acc.consume(toolCallCompleted('tc1', 'repo.read', 1, '{"path":"x"}'))).toEqual([]);
        const flushed = acc.flush();
        expect(flushed).toHaveLength(1);
        expect(flushed[0]).toMatchObject({ kind: 'tool', toolCallId: 'tc1', status: 'pending' });
    });

    it('flush emits a partial assistant-text block when response_completed never arrived', () => {
        const acc = createBlockAccumulator();
        acc.consume(textDelta('r1', 1, 'partial '));
        acc.consume(textDelta('r1', 2, 'text'));
        const flushed = acc.flush();
        expect(flushed).toHaveLength(1);
        expect(flushed[0]).toMatchObject({ kind: 'assistant-text', text: 'partial text' });
    });

    it('flush emits a partial reasoning block when reasoning_completed never arrived', () => {
        const acc = createBlockAccumulator();
        acc.consume(reasoningDelta('r1', 1, 'half '));
        const flushed = acc.flush();
        expect(flushed).toHaveLength(1);
        expect(flushed[0]).toMatchObject({ kind: 'reasoning', text: 'half ' });
    });

    it('batch foldEvents and incremental accumulator produce identical output for the same event sequence', () => {
        const events: AgentEvent[] = [
            event({ type: 'run.started', modelProviderSelection: { providerID: 'openai', modelID: 'gpt-5' } }),
            reasoningDelta('r1', 1, 'think'),
            reasoningCompleted('r1', 2, 'think'),
            textDelta('r1', 3, 'Hi'),
            responseCompleted('r1', 4, 'Hi'),
            toolCallCompleted('tc1', 'repo.read', 5, '{}'),
            toolResultEvent('tc1', 'completed', 'out'),
        ];
        const batch = foldEvents(events);
        const acc = createBlockAccumulator();
        const incremental = events.flatMap((e) => acc.consume(e)).concat(acc.flush());
        expect(incremental).toEqual(batch);
    });

    it('does not re-emit flushed blocks; new events after flush produce new blocks (stale_state probe)', () => {
        const acc = createBlockAccumulator();
        // response_completed closes the text block inside consume, so flush must stay empty
        const consumed = acc.consume(textDelta('r1', 1, 'a')).concat(acc.consume(responseCompleted('r1', 2, 'a')));
        expect(consumed).toHaveLength(1);
        expect(acc.flush()).toEqual([]);
        // reuse after flush: no stale re-emission
        expect(acc.flush()).toEqual([]);
        // new turn works
        const second = acc.consume(textDelta('r2', 3, 'b')).concat(acc.consume(responseCompleted('r2', 4, 'b')));
        expect(second).toHaveLength(1);
        expect(second[0]).toMatchObject({ kind: 'assistant-text', text: 'b' });
    });

    it('concatenates out-of-order deltas by sequence defensively', () => {
        const acc = createBlockAccumulator();
        acc.consume(textDelta('r1', 3, 'C'));
        acc.consume(textDelta('r1', 1, 'A'));
        acc.consume(textDelta('r1', 2, 'B'));
        const flushed = acc.flush();
        expect(flushed[0]).toMatchObject({ kind: 'assistant-text', text: 'ABC' });
    });
});

describe('graceful handling of malformed input', () => {
    it('does not throw on events with missing providerStreamChunk', () => {
        expect(() => foldEvents([event({ type: 'log', message: 'stray' })])).not.toThrow();
    });

    it('does not throw on a toolResult with no matching open tool block', () => {
        expect(() => foldEvents([toolResultEvent('orphan', 'completed', 'x')])).not.toThrow();
        const blocks = foldEvents([toolResultEvent('orphan', 'completed', 'x')]);
        // orphan toolResult still surfaces a tool block so the result is not silently lost
        expect(blocks.some((b) => b.kind === 'tool' && 'toolCallId' in b && b.toolCallId === 'orphan')).toBe(true);
    });

    it('does not throw on a toolResult missing toolCallId-shaped data via empty string fallback gracefully', () => {
        // A toolResult must have a toolCallId per schema; we only assert the folder does not throw on
        // a well-formed orphan result (covered above) and on a bare tool.completed event.
        expect(() => foldEvents([event({ type: 'tool.completed' })])).not.toThrow();
    });

    it('treats text deltas and reasoning deltas for different requestIds as separate blocks', () => {
        const blocks = foldEvents([
            textDelta('r-text', 1, 't1'),
            reasoningDelta('r-reason', 2, 'r1'),
            responseCompleted('r-text', 3, 't1'),
            reasoningCompleted('r-reason', 4, 'r1'),
        ]);
        expect(blocks.filter((b) => b.kind === 'assistant-text')).toHaveLength(1);
        expect(blocks.filter((b) => b.kind === 'reasoning')).toHaveLength(1);
    });

    it('emits a reasoning block from response_completed.message.reasoning when no reasoning stream arrived', () => {
        const blocks = foldEvents([responseCompleted('r1', 1, 'answer', 'inline reasoning')]);
        const reasoning = blocks.filter((b) => b.kind === 'reasoning');
        const text = blocks.filter((b) => b.kind === 'assistant-text');
        expect(text).toHaveLength(1);
        expect(reasoning).toHaveLength(1);
        expect(reasoning[0]).toMatchObject({ kind: 'reasoning', text: 'inline reasoning' });
    });
});

describe('graph-path event handling', () => {
    it('emits session-header from graph.started carrying modelProviderSelection', () => {
        const blocks = foldEvents([
            event({
                type: 'graph.started',
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                abg: { graphId: 'default' },
            }),
        ]);
        const headers = blocks.filter((b) => b.kind === 'session-header');
        expect(headers).toHaveLength(1);
        expect(headers[0]).toEqual({ kind: 'session-header', providerID: 'local', modelID: 'local-echo' });
    });

    it('emits session-header from session.started (first event with modelProviderSelection)', () => {
        const blocks = foldEvents([
            event({
                type: 'session.started',
                sessionId: 's1',
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            }),
        ]);
        expect(blocks.some((b) => b.kind === 'session-header')).toBe(true);
    });

    it('emits assistant-text from model.call.completed with message', () => {
        const blocks = foldEvents([
            event({
                type: 'model.call.completed',
                message: 'received prompt: hello',
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                abg: { graphId: 'default', nodeId: 'intent-gate', nodeKind: 'llm' },
            }),
        ]);
        const text = blocks.filter((b) => b.kind === 'assistant-text');
        expect(text).toHaveLength(1);
        expect(text[0]).toEqual({ kind: 'assistant-text', text: 'received prompt: hello' });
    });

    it('skips generic model.call.completed label messages', () => {
        const blocks = foldEvents([
            event({
                type: 'model.call.completed',
                message: 'model.call.completed: intent-gate',
                abg: { graphId: 'default', nodeId: 'intent-gate', nodeKind: 'llm' },
            }),
        ]);
        expect(blocks.filter((b) => b.kind === 'assistant-text')).toHaveLength(0);
    });

    it('does not double-emit assistant-text when response_completed chunk is present', () => {
        const blocks = foldEvents([
            event({
                type: 'model.call.completed',
                message: 'from event.message',
                providerStreamChunk: {
                    kind: 'response_completed',
                    requestId: 'r1',
                    sequence: 1,
                    message: { messageId: 'm1', role: 'assistant', content: 'from chunk' },
                    finishReason: 'stop',
                },
            }),
        ]);
        const text = blocks.filter((b) => b.kind === 'assistant-text');
        expect(text).toHaveLength(1);
        expect(text[0]).toEqual({ kind: 'assistant-text', text: 'from chunk' });
    });

    it('emits assistant-text for each model.call.completed in a multi-node graph', () => {
        const blocks = foldEvents([
            event({
                type: 'model.call.completed',
                message: 'classification result',
                abg: { graphId: 'default', nodeId: 'intent-gate', nodeKind: 'llm' },
            }),
            event({
                type: 'model.call.completed',
                message: 'clarifying question',
                abg: { graphId: 'default', nodeId: 'clarify', nodeKind: 'llm' },
            }),
        ]);
        const text = blocks.filter((b) => b.kind === 'assistant-text');
        expect(text).toHaveLength(2);
        expect(text[0]).toMatchObject({ text: 'classification result' });
        expect(text[1]).toMatchObject({ text: 'clarifying question' });
    });

    it('produces session-header and assistant-text from a realistic graph event sequence', () => {
        const blocks = foldEvents([
            event({
                type: 'graph.started',
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                abg: { graphId: 'default' },
            }),
            event({
                type: 'model.call.completed',
                message: 'received prompt: hello',
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                abg: { graphId: 'default', nodeId: 'intent-gate', nodeKind: 'llm' },
            }),
        ]);
        expect(blocks.map((b) => b.kind)).toEqual(['session-header', 'assistant-text']);
    });
});
