import type { AgentEvent } from '@mission-control/protocol';
import { describe, expect, it, vi } from 'vitest';
import { type AgentUIRenderer, JsonRenderer, PlainRenderer, TuiRenderer } from '../ui/renderers.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TS = '2026-07-05T02:00:00.000Z';

function event(partial: Partial<AgentEvent> & { type: AgentEvent['type'] }): AgentEvent {
    return { timestamp: TS, ...partial } as AgentEvent;
}

function runStarted(): AgentEvent {
    return event({
        type: 'run.started',
        sessionId: 'session_seam',
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

function toolResultEvent(toolCallId: string, output: string): AgentEvent {
    return event({
        type: 'tool.completed',
        toolResult: { toolCallId, status: 'completed', output },
    });
}

/**
 * Mirrors the exact gate expression at run-agent.ts return path:
 *   return renderer.streamedOutput === true ? '' : renderer.getOutput();
 * Streamed renderers (Plain/Tui) already wrote blocks to stdout during render(),
 * so the tail write from index.tsx must receive '' (no-op). Non-streamed (Json)
 * returns the full string so index.tsx writes it once at end.
 */
function seamReturnValue(renderer: AgentUIRenderer): string {
    return renderer.streamedOutput === true ? '' : renderer.getOutput();
}

describe('runAgent streaming seam (T8)', () => {
    it('PlainRenderer: streamedOutput=true -> seam returns "" -> tail write is a no-op (NO double-print)', () => {
        const renderer = new PlainRenderer({ thinking: true });
        const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

        renderer.render(runStarted());
        renderer.render(textDelta('r1', 1, 'Hel'));
        renderer.render(textDelta('r1', 2, 'lo'));
        renderer.render(responseCompleted('r1', 3, 'Hello'));
        renderer.render(toolCallCompleted('tc1', 'file.patch', 4, '{"path":"src/a.ts"}'));
        renderer.render(toolResultEvent('tc1', 'patch applied'));

        const writesDuringRender = writeSpy.mock.calls.length;
        const contentDuringRender = writeSpy.mock.calls.map((c) => String(c[0])).join('');

        const returnValue = seamReturnValue(renderer);

        process.stdout.write(returnValue);

        const allCalls = [...writeSpy.mock.calls];
        const tailCall = allCalls.at(-1);
        const tailWriteArg = tailCall !== undefined ? String(tailCall[0]) : '<no tail call>';
        const allContent = allCalls.map((c) => String(c[0])).join('');

        writeSpy.mockRestore();

        expect(renderer.streamedOutput).toBe(true);
        expect(returnValue).toBe('');
        expect(tailWriteArg).toBe('');
        expect(allCalls.length).toBe(writesDuringRender + 1);
        const helloCount = (allContent.match(/Hello/g) ?? []).length;
        expect(helloCount).toBe(1);

        dumpEvidence('plain', returnValue, allCalls, writesDuringRender, contentDuringRender);
    });

    it('TuiRenderer: streamedOutput=true -> seam returns "" -> tail write is a no-op', () => {
        const renderer = new TuiRenderer({ thinking: false });
        const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

        renderer.render(runStarted());
        renderer.render(responseCompleted('r1', 1, 'From TuiRenderer'));

        const writesDuringRender = writeSpy.mock.calls.length;

        const returnValue = seamReturnValue(renderer);
        process.stdout.write(returnValue);

        const allCalls = [...writeSpy.mock.calls];
        const tailCall = allCalls.at(-1);
        const tailWriteArg = tailCall !== undefined ? String(tailCall[0]) : '<no tail call>';
        const allContent = allCalls.map((c) => String(c[0])).join('');

        writeSpy.mockRestore();

        expect(renderer.streamedOutput).toBe(true);
        expect(returnValue).toBe('');
        expect(tailWriteArg).toBe('');
        expect(allCalls.length).toBe(writesDuringRender + 1);
        const answerCount = (allContent.match(/From TuiRenderer/g) ?? []).length;
        expect(answerCount).toBe(1);
    });

    it('JsonRenderer: streamedOutput undefined -> ZERO writes during render -> seam returns full NDJSON -> single tail write', () => {
        const renderer: AgentUIRenderer = new JsonRenderer();
        const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

        renderer.render(runStarted());
        renderer.render(textDelta('r1', 1, 'Hel'));
        renderer.render(responseCompleted('r1', 2, 'Hello'));

        const writesDuringRender = writeSpy.mock.calls.length;

        const returnValue = seamReturnValue(renderer);

        process.stdout.write(returnValue);

        const writesAfterTail = writeSpy.mock.calls.length;
        const capturedCalls = [...writeSpy.mock.calls];

        writeSpy.mockRestore();

        expect(renderer.streamedOutput).toBeUndefined();
        expect(writesDuringRender).toBe(0);
        expect(returnValue).not.toBe('');
        expect(returnValue.trim().length).toBeGreaterThan(0);
        expect(writesAfterTail).toBe(1);
        const records = returnValue
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(records).toHaveLength(3);

        dumpEvidence('json', returnValue, capturedCalls, writesDuringRender, '');
    });

    it('getOutput() is idempotent and never writes to stdout (stale_state probe)', () => {
        const renderer = new PlainRenderer();
        const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

        renderer.render(runStarted());
        renderer.render(responseCompleted('r1', 1, 'Idempotent output'));

        writeSpy.mockClear();

        const first = renderer.getOutput();
        const second = renderer.getOutput();
        const writesDuringGetOutput = writeSpy.mock.calls.length;

        writeSpy.mockRestore();

        expect(first).toBe(second);
        expect(writesDuringGetOutput).toBe(0);
        expect(first).toContain('Idempotent output');
    });
});

function dumpEvidence(
    mode: string,
    returnValue: string,
    calls: ReadonlyArray<readonly unknown[]>,
    writesDuringRender: number,
    contentDuringRender: string,
): void {
    const lines: string[] = [];
    lines.push(`T8 streaming-seam evidence (${mode})`);
    lines.push('Captured: process.stdout.write spy across render() + simulated tail write.');
    lines.push('');
    lines.push(`== writes during render(): ${writesDuringRender} ==`);
    lines.push(`== content during render() (raw): ${JSON.stringify(contentDuringRender)} ==`);
    lines.push(`== seam return value: ${JSON.stringify(returnValue)} ==`);
    lines.push('');
    lines.push('== all stdout.write calls (sequence) ==');
    let i = 0;
    for (const call of calls) {
        i += 1;
        lines.push(`  [write #${i}] ${JSON.stringify(String(call[0]))}`);
    }
    const filename =
        mode === 'json' ? 'task-8-opencode-style-block-output-json.txt' : 'task-8-opencode-style-block-output.txt';
    const evidencePath = `.omo/evidence/${filename}`;
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, `${lines.join('\n')}\n`);
}
