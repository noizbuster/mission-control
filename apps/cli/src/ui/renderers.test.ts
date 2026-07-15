import { AgentRuntime } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { darkTheme, noColorTheme } from '@mission-control/tui/markdown-theme';
import { describe, expect, it, vi } from 'vitest';
import { joinBlocks, type RenderBlockOptions, renderBlock } from './block-renderer.js';
import type { OutputBlock } from './output-blocks.js';
import { type AgentUIRenderer, JsonRenderer, PlainRenderer, TuiRenderer } from './renderers.js';

// allow: SIZE_OK -- HEAD 250 -> current 266 pure LOC; renderer event integration matrix requires a shared fixture pipeline.
const TS = '2026-07-05T02:00:00.000Z';

/**
 * Construct a typed AgentEvent fixture from a partial. Mirrors the helper in
 * run-agent-streaming-seam.test.ts: AgentEvent is a discriminated union, so
 * inline construction is verbose; the cast narrows the spread to the union.
 */
function event(partial: Partial<AgentEvent> & { type: AgentEvent['type'] }): AgentEvent {
    return { timestamp: TS, ...partial } as AgentEvent;
}

const bareTaskCompleted: AgentEvent = event({
    type: 'task.completed',
    sessionId: 'session_test',
    taskId: 'task_1',
    message: 'completed by mock sidecar',
    nativeSidecarStatus: 'mock',
    modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
});

/**
 * PlainRenderer/TuiRenderer stream each rendered block to stdout during
 * render() (T7). Spy on stdout.write so streamed blocks do not pollute the
 * vitest reporter. Returns a restore function.
 */
function silenceStdout(): () => void {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    return () => spy.mockRestore();
}

async function renderEvents(renderer: AgentUIRenderer, events: readonly AgentEvent[]): Promise<string> {
    const restore = silenceStdout();
    try {
        await renderer.start(new AgentRuntime({ useNative: false }));
        for (const e of events) renderer.render(e);
        await renderer.stop();
        return renderer.getOutput();
    } finally {
        restore();
    }
}

function runStarted(providerID: string, modelID: string): AgentEvent {
    return event({
        type: 'run.started',
        sessionId: 'session_blocks',
        modelProviderSelection: { providerID, modelID },
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

function reasoningCompleted(requestId: string, sequence: number, text: string): AgentEvent {
    return event({
        type: 'task.progress',
        providerStreamChunk: { kind: 'reasoning_completed', requestId, sequence, text },
    });
}

function toolCallCompleted(toolCallId: string, toolName: string, sequence: number, argumentsJson: string): AgentEvent {
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

function toolResultEvent(toolCallId: string, output: string): AgentEvent {
    return event({
        type: 'tool.completed',
        toolResult: { toolCallId, status: 'completed', output },
    });
}

describe('CLI renderers', () => {
    it('a bare task.completed emits only a session-header (from modelProviderSelection); JsonRenderer still emits NDJSON', async () => {
        const plainOutput = await renderEvents(new PlainRenderer(), [bareTaskCompleted]);
        const tuiOutput = await renderEvents(new TuiRenderer(), [bareTaskCompleted]);
        const jsonOutput = await renderEvents(new JsonRenderer(), [bareTaskCompleted]);

        // task.completed carries modelProviderSelection, which now triggers the session-header
        // (broadened from run.started/task.started to any event with modelProviderSelection).
        // No assistant-text or tool blocks are produced.
        expect(plainOutput).toBe('\n> local \u00b7 local-echo\n');
        expect(tuiOutput).toBe('\n> local \u00b7 local-echo\n');

        // JsonRenderer is byte-unchanged: NDJSON per event with machine state.
        expect(JSON.parse(jsonOutput.trim())).toMatchObject({
            type: 'task.completed',
            taskId: 'task_1',
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
            },
        });
    });

    it('emits a session-header block and an assistant-text block separated by a blank line', async () => {
        const events: AgentEvent[] = [runStarted('local', 'local-echo'), responseCompleted('r1', 1, 'Hello world.')];
        const output = await renderEvents(new PlainRenderer(), events);

        // session-header block renders the opencode-style "> provider · model" line.
        expect(output).toContain('> local \u00b7 local-echo');
        // assistant-text block renders the authoritative message content.
        expect(output).toContain('Hello world.');
        // blocks are blank-line separated (joinBlocks collapses to at most \n\n).
        expect(output).toContain('\n\n');
        // the old flat event-log format is gone.
        expect(output).not.toContain('provider: local');
        expect(output).not.toContain('selection: local/local-echo');
        expect(output).not.toContain('event list');
    });

    it('joinBlocks collapses runs of newlines so adjacent blocks get exactly one blank line', () => {
        const opts: RenderBlockOptions = { width: 80, tty: false, thinking: false, theme: noColorTheme };
        const blocks: OutputBlock[] = [
            { kind: 'session-header', providerID: 'p', modelID: 'm' },
            { kind: 'assistant-text', text: 'first' },
            { kind: 'assistant-text', text: 'second' },
        ];
        const output = joinBlocks(blocks.map((b) => renderBlock(b, opts)));

        expect(output).toContain('first\n\nsecond');
        expect(output).not.toMatch(/\n{3,}/);
    });

    it('renders read-class tools as a compact inline one-liner and file.patch as a multi-line block', () => {
        const opts: RenderBlockOptions = { width: 80, tty: false, thinking: false, theme: noColorTheme };
        const readBlock: OutputBlock = {
            kind: 'tool',
            toolCallId: 'tc1',
            toolName: 'read',
            argumentsJson: '{"path":"/src/index.ts"}',
            status: 'completed',
        };
        const patchBlock: OutputBlock = {
            kind: 'tool',
            toolCallId: 'tc2',
            toolName: 'file.patch',
            argumentsJson: '{}',
            status: 'completed',
            output: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new',
        };

        const readRendered = renderBlock(readBlock, opts);
        const patchRendered = renderBlock(patchBlock, opts);

        // read: inline one-liner; the JSON path value is extracted as the summary.
        expect(readRendered).toContain('\u2699 read /src/index.ts');
        expect(readRendered).not.toContain('path');
        expect(readRendered.split('\n').filter((line) => line !== '')).toHaveLength(1);

        // file.patch: expanded block with header + multi-line body.
        expect(patchRendered).toContain('\u2699 file.patch');
        expect(patchRendered).toContain('--- a/f');
        expect(patchRendered).toContain('+new');
        expect(patchRendered.split('\n').filter((line) => line !== '').length).toBeGreaterThan(2);
    });

    it('renders assistant-text markdown into visible text with syntax stripped', async () => {
        const output = await renderEvents(new PlainRenderer(), [responseCompleted('r1', 1, '**bold** and `code`')]);

        expect(output).toContain('bold');
        expect(output).toContain('code');
        expect(output).not.toContain('**');
        expect(output).not.toContain('`code`');
    });

    it('suppresses reasoning blocks by default and renders them when thinking=true', async () => {
        const reasoningEvents: AgentEvent[] = [reasoningCompleted('r1', 1, 'secret chain of thought')];

        const suppressed = await renderEvents(new PlainRenderer(), reasoningEvents);
        expect(suppressed).toBe('');
        expect(suppressed).not.toContain('secret chain of thought');

        const visible = await renderEvents(new PlainRenderer({ thinking: true }), reasoningEvents);
        expect(visible).toContain('secret chain of thought');
    });

    it('folds a multi-event turn (header + text + tool) through the full accumulator pipeline', async () => {
        const events: AgentEvent[] = [
            runStarted('openai', 'gpt-5'),
            responseCompleted('r1', 1, 'Answer.'),
            toolCallCompleted('tc1', 'file.patch', 2, '{}'),
            toolResultEvent('tc1', 'patch applied'),
        ];
        const output = await renderEvents(new PlainRenderer(), events);

        expect(output).toContain('> openai \u00b7 gpt-5');
        expect(output).toContain('Answer.');
        expect(output).toContain('\u2699 file.patch');
        expect(output).toContain('patch applied');
    });

    it('keeps plain and buffered TUI renderer block output byte-identical', async () => {
        const events: AgentEvent[] = [
            runStarted('openai', 'gpt-5'),
            reasoningCompleted('r1', 1, 'Reasoning.'),
            responseCompleted('r1', 2, '# Answer\n\nWith **formatting**.'),
            toolCallCompleted('tc1', 'read', 3, '{"path":"README.md"}'),
        ];

        const plain = await renderEvents(new PlainRenderer({ thinking: true }), events);
        const tui = await renderEvents(new TuiRenderer({ thinking: true }), events);

        expect(plain).toBe(tui);
    });

    it('emits zero ANSI escape bytes when tty=false across every block kind', () => {
        const opts: RenderBlockOptions = { width: 80, tty: false, thinking: true, theme: darkTheme };
        const blocks: OutputBlock[] = [
            { kind: 'session-header', providerID: 'p', modelID: 'm' },
            { kind: 'assistant-text', text: '# Heading\n\nbody with **bold**' },
            { kind: 'reasoning', text: 'a thought' },
            {
                kind: 'tool',
                toolCallId: 'tc1',
                toolName: 'read',
                argumentsJson: '{"path":"/f"}',
                status: 'completed',
            },
            { kind: 'error', message: 'boom' },
        ];
        const output = joinBlocks(blocks.map((b) => renderBlock(b, opts)));

        expect(output.includes('\x1b')).toBe(false);
        // structure and visible text survive even without color.
        expect(output).toContain('Heading');
        expect(output).toContain('bold');
        expect(output).toContain('a thought');
        expect(output).toContain('\u2699 read');
        expect(output).toContain('Error:');
    });

    it('json renderer includes machine-readable run state metadata', async () => {
        const renderer = new JsonRenderer();

        renderer.render({
            type: 'run.started',
            timestamp: '2026-06-13T00:00:00.000Z',
            sessionId: 'session_json_machine',
            message: 'run started',
            run: {
                command: 'run',
                state: 'running',
                runId: 'run_json_machine',
            },
        });
        renderer.render({
            type: 'run.completed',
            timestamp: '2026-06-13T00:00:01.000Z',
            sessionId: 'session_json_machine',
            message: 'run completed',
            run: {
                command: 'run',
                state: 'completed',
                runId: 'run_json_machine',
            },
        });
        renderer.render({
            type: 'session.stopped',
            timestamp: '2026-06-13T00:00:02.000Z',
            sessionId: 'session_json_machine',
            message: 'mission-control session stopped',
            nativeSidecarStatus: 'mock',
        });

        const records = renderer
            .getOutput()
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        const finalRecord = records.at(-1);

        expect(finalRecord).toMatchObject({
            type: 'session.stopped',
            sessionId: 'session_json_machine',
            status: 'completed',
            runId: 'run_json_machine',
            machine: {
                session: {
                    sessionId: 'session_json_machine',
                },
                run: {
                    runId: 'run_json_machine',
                    status: 'completed',
                },
            },
        });
    });
});
