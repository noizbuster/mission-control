import type { AgentEvent } from '@mission-control/protocol';
import { describe, expect, it, vi } from 'vitest';
import { JsonRenderer, PlainRenderer, TuiRenderer } from './renderers.js';
import { writeFileSync } from 'node:fs';

const TS = '2026-07-05T00:00:00.000Z';

function event(partial: Partial<AgentEvent> & { type: AgentEvent['type'] }): AgentEvent {
    return { timestamp: TS, ...partial } as AgentEvent;
}

function runStarted(): AgentEvent {
    return event({
        type: 'run.started',
        sessionId: 'session_stream',
        modelProviderSelection: { providerID: 'openai', modelID: 'gpt-5', variantID: 'reasoning-high' },
    });
}

function textDelta(requestId: string, sequence: number, delta: string): AgentEvent {
    return event({
        type: 'task.progress',
        providerStreamChunk: { kind: 'text_delta', requestId, sequence, delta },
    });
}

function responseCompleted(requestId: string, sequence: number, content: string): AgentEvent {
    return event({
        type: 'task.progress',
        providerStreamChunk: {
            kind: 'response_completed',
            requestId,
            sequence,
            message: { messageId: 'm1', role: 'assistant', content },
            finishReason: 'stop',
        },
    });
}

function toolCallCompleted(toolCallId: string, toolName: string, sequence: number, args = '{}'): AgentEvent {
    return event({
        type: 'task.progress',
        providerStreamChunk: {
            kind: 'tool_call_completed',
            requestId: 'req-tool',
            sequence,
            toolCall: { toolCallId, toolName, argumentsJson: args },
        },
    });
}

function toolResultEvent(toolCallId: string, status: 'completed' | 'failed', output?: string): AgentEvent {
    return event({
        type: status === 'completed' ? 'tool.completed' : 'tool.failed',
        toolResult: { toolCallId, status, ...(output !== undefined ? { output } : {}) },
    });
}

describe('PlainRenderer streaming', () => {
    it('writes each completed block to stdout during render() and getOutput() returns the accumulation', () => {
        const renderer = new PlainRenderer({ thinking: true });
        const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

        renderer.render(runStarted());
        const writesAfterHeader = writeSpy.mock.calls.length;
        renderer.render(textDelta('r1', 1, 'Hel'));
        const writesAfterDelta1 = writeSpy.mock.calls.length;
        renderer.render(textDelta('r1', 2, 'lo'));
        const writesAfterDelta2 = writeSpy.mock.calls.length;
        renderer.render(responseCompleted('r1', 3, 'Hello'));
        const writesAfterResponse = writeSpy.mock.calls.length;
        renderer.render(toolCallCompleted('tc1', 'file.patch', 4, '{"path":"src/a.ts"}'));
        const writesAfterToolCall = writeSpy.mock.calls.length;
        renderer.render(toolResultEvent('tc1', 'completed', 'patch applied'));
        const writesAfterToolResult = writeSpy.mock.calls.length;

        const output = renderer.getOutput();
        const capturedCalls = [...writeSpy.mock.calls];

        writeSpy.mockRestore();

        expect(writesAfterHeader).toBe(1);
        expect(writesAfterDelta1).toBe(1);
        expect(writesAfterDelta2).toBe(1);
        expect(writesAfterResponse).toBe(2);
        expect(writesAfterToolCall).toBe(2);
        expect(writesAfterToolResult).toBe(3);
        expect(output).toContain('openai');
        expect(output).toContain('Hello');
        expect(output).toContain('file.patch');
        expect(output).toContain('patch applied');

        dumpEvidence(output, capturedCalls, [
            { label: 'after run.started (session-header)', count: writesAfterHeader },
            { label: 'after text_delta #1 (accumulate, 0 new)', count: writesAfterDelta1 },
            { label: 'after text_delta #2 (accumulate, 0 new)', count: writesAfterDelta2 },
            { label: 'after response_completed (assistant-text)', count: writesAfterResponse },
            { label: 'after tool_call_completed (open tool, 0 new)', count: writesAfterToolCall },
            { label: 'after tool.completed (tool block)', count: writesAfterToolResult },
        ]);
    });

    it('JsonRenderer makes ZERO stdout writes during render() (output only at getOutput)', () => {
        const renderer = new JsonRenderer();
        const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

        renderer.render(runStarted());
        renderer.render(textDelta('r1', 1, 'Hel'));
        renderer.render(responseCompleted('r1', 2, 'Hello'));
        const writesDuringRender = writeSpy.mock.calls.length;

        const output = renderer.getOutput();
        writeSpy.mockRestore();

        expect(writesDuringRender).toBe(0);
        const records = output
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(records).toHaveLength(3);
    });

    it('appends correctly across two render batches (stale_state probe)', () => {
        const renderer = new PlainRenderer();
        const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

        renderer.render(runStarted());
        renderer.render(responseCompleted('r1', 1, 'First answer'));
        const firstOutput = renderer.getOutput();

        renderer.render(toolCallCompleted('tc1', 'file.patch', 2, '{"path":"a.ts"}'));
        renderer.render(toolResultEvent('tc1', 'completed', 'file contents'));
        const secondOutput = renderer.getOutput();

        writeSpy.mockRestore();

        expect(firstOutput).toContain('First answer');
        expect(firstOutput).not.toContain('file contents');
        expect(secondOutput).toContain('First answer');
        expect(secondOutput).toContain('file contents');
        expect(secondOutput.length).toBeGreaterThan(firstOutput.length);
    });

    it('does not throw or emit spurious blocks for events without a providerStreamChunk (malformed_input)', () => {
        const renderer = new PlainRenderer();
        const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

        expect(() => renderer.render(event({ type: 'session.stopped', sessionId: 's', message: 'bye' }))).not.toThrow();

        const writes = writeSpy.mock.calls.length;
        const output = renderer.getOutput();
        writeSpy.mockRestore();

        expect(writes).toBe(0);
        expect(output).toBe('');
    });

    it('TuiRenderer streams the same block pipeline as PlainRenderer', () => {
        const renderer = new TuiRenderer({ thinking: false });
        const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

        renderer.render(runStarted());
        renderer.render(responseCompleted('r1', 1, 'From TuiRenderer'));
        const writes = writeSpy.mock.calls.length;
        const output = renderer.getOutput();

        writeSpy.mockRestore();

        expect(writes).toBe(2);
        expect(output).toContain('From TuiRenderer');
    });
});

function dumpEvidence(
    output: string,
    calls: ReadonlyArray<readonly unknown[]>,
    perRender: ReadonlyArray<{ readonly label: string; readonly count: number }>,
): void {
    const lines: string[] = [];
    lines.push('T7 streaming stdout-spy evidence (PlainRenderer, thinking:true, non-TTY)');
    lines.push('Captured: process.stdout.write spy invocations across a scripted event sequence.');
    lines.push('');
    lines.push('== Per-render() write-call counts (proves streaming, not end-dump) ==');
    for (const step of perRender) {
        lines.push(`  ${step.label}: stdout.write called ${step.count} time(s)`);
    }
    lines.push('');
    lines.push('== Captured stdout.write arguments (raw strings) ==');
    let i = 0;
    for (const call of calls) {
        const arg = call[0];
        const text = typeof arg === 'string' ? arg : String(arg);
        i += 1;
        lines.push(`  [write #${i}] ${JSON.stringify(text)}`);
    }
    lines.push('');
    lines.push('== getOutput() (joinBlocks accumulation) ==');
    lines.push(JSON.stringify(output));
    lines.push('');
    lines.push('== getOutput() rendered (printable) ==');
    lines.push(output);
    writeFileSync('.omo/evidence/task-7-opencode-style-block-output.txt', `${lines.join('\n')}\n`);
}
