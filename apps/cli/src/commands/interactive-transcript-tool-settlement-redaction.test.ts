import { ToolCallSchema } from '@mission-control/protocol';
import { createChatStore } from '@mission-control/tui/state';
import { describe, expect, it, vi } from 'vitest';
import { createStoreChatOutput } from './chat-agent-runner';
import { interactiveGraphStreamSignal, renderInteractiveGraphDurableEvent } from './interactive-coding-graph-rendering';
import { renderInteractiveToolSettlement } from './interactive-coding-provider-rendering';
import { renderToolPreview } from './interactive-coding-tool-preview';
import { completedSettlement } from './interactive-transcript-emission-test-support';
import {
    commandOutput,
    commandStructuredOutput,
    createPlainRecording,
    createRichRecording,
    graphDelta,
    graphFailure,
    renderState,
    toolCompleted,
    turnCompleted,
    turnStarted,
} from './interactive-transcript-fallback-test-support';

describe('fallback-only graph transcript rendering', () => {
    it('emits the graph tool-count summary as typed status plus identical fallback bytes', async () => {
        // Given
        const recording = createRichRecording();
        const state = renderState();

        // When
        await interactiveGraphStreamSignal(recording.output, state, '/workspace')(turnStarted('tool-node', 'turn'));
        renderInteractiveGraphDurableEvent(
            recording.output,
            state,
            toolCompleted('tool-node', { toolCallId: 'call-read', toolName: 'repo.read', output: 'contents' }),
        );
        renderInteractiveGraphDurableEvent(recording.output, state, turnCompleted('tool-node', 'answer'));

        // Then
        expect(recording.transcriptWrites.map(({ part }) => part)).toContainEqual({
            id: 'graph:outer-default:tool-node-turn-started:tools',
            type: 'status',
            text: '✓ 1 tool (repo.read)',
            status: 'completed',
        });
        expect(recording.rawWrites).toEqual([]);
        expect(recording.fallbackBytes.join('')).toBe(
            '✓ repo.read: contents\n✓ 1 tool (repo.read)\nAssistant: answer\n',
        );
    });

    it('settles an expanded command preview without moving or discarding its argument detail', async () => {
        // Given
        const store = createChatStore();
        const output = createStoreChatOutput(store);
        const state = renderState('command-preview-turn');
        const toolCall = ToolCallSchema.parse({
            toolCallId: 'call-command-preview',
            toolName: 'command.run',
            argumentsJson: JSON.stringify({ command: 'pnpm', args: ['test'] }),
        });

        // When
        await renderToolPreview(toolCall, output, {
            state,
            workspaceRoot: '/workspace',
        });
        renderInteractiveToolSettlement(
            output,
            completedSettlement({
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                modelOutput: commandOutput,
                structuredOutput: commandStructuredOutput,
            }),
            state,
        );

        // Then
        expect(store.getSnapshot().transcriptParts.map((part) => part.id)).toEqual([
            'tool:command-preview-turn:call-command-preview:occurrence:1',
            'tool:command-preview-turn:call-command-preview:occurrence:1:preview',
        ]);
        expect(store.getSnapshot().transcriptParts[0]).toEqual(
            expect.objectContaining({
                id: 'tool:command-preview-turn:call-command-preview:occurrence:1',
                type: 'command',
                toolCallId: 'call-command-preview',
                command: 'pnpm test',
                detail: commandOutput,
                status: 'completed',
            }),
        );
        expect(store.getSnapshot().transcriptParts[1]).toEqual({
            id: 'tool:command-preview-turn:call-command-preview:occurrence:1:preview',
            type: 'command',
            toolCallId: 'call-command-preview',
            text: '$ pnpm test',
            title: 'Command preview for command.run',
            detail: '$ pnpm test',
            status: 'completed',
            command: 'pnpm test',
        });
        expect(store.getOutput()).toBe(
            'tool: command.run $ pnpm test\n' +
                'Command preview for command.run\n$ pnpm test\n' +
                'Command output for command.run: first line · second line\n' +
                'Command output for command.run\nfirst line\nsecond line\n',
        );
    });

    it('preserves plain graph text and reasoning fallback bytes exactly', async () => {
        // Given
        const graph = createPlainRecording();
        const state = renderState();
        const tap = interactiveGraphStreamSignal(graph.output, state, '/workspace');

        // When
        await tap(graphDelta('plain-node', 'llm.text.delta', 'Hel'));
        await tap(graphDelta('plain-node', 'llm.text.delta', 'lo'));
        renderInteractiveGraphDurableEvent(graph.output, state, turnCompleted('plain-node', 'Hello'));
        await tap(graphDelta('plain-node', 'llm.reasoning.delta', 'inspect'));
        renderInteractiveGraphDurableEvent(graph.output, state, turnCompleted('plain-node', ''));

        // Then
        expect(graph.writes.join('')).toBe('Assistant: Hello\nThinking: inspect\n');
    });

    it('redacts non-retryable graph signal failures in typed and fallback output', async () => {
        // Given
        const secret = 'sk-signalfailure123';
        const message = `provider rejected ${secret}`;
        const rich = createRichRecording();
        const plain = createPlainRecording();

        // When
        const richTap = interactiveGraphStreamSignal(rich.output, renderState(), '/workspace');
        const plainTap = interactiveGraphStreamSignal(plain.output, renderState(), '/workspace');
        await richTap(turnStarted('failure-node', 'turn'));
        await plainTap(turnStarted('failure-node', 'turn'));
        await richTap(graphFailure('failure-node', message));
        await plainTap(graphFailure('failure-node', message));

        // Then
        expect(rich.transcriptWrites.map(({ part }) => part)).toEqual([
            {
                id: 'graph:outer-default:failure-node-turn-started:error',
                type: 'error',
                text: 'provider rejected [REDACTED_CREDENTIAL]',
                error: 'provider rejected [REDACTED_CREDENTIAL]',
                status: 'failed',
            },
        ]);
        expect(rich.fallbackBytes).toEqual(['✗ failure-node: provider rejected [REDACTED_CREDENTIAL]\n']);
        expect(plain.writes).toEqual(['✗ failure-node: provider rejected [REDACTED_CREDENTIAL]\n']);
        expect(JSON.stringify({ rich, plain })).not.toContain(secret);
    });

    it('preserves non-secret graph signal failure fallback bytes exactly', async () => {
        // Given
        const rich = createRichRecording();
        const plain = createPlainRecording();
        const failure = graphFailure('ordinary-node', 'ordinary failure');

        // When
        await interactiveGraphStreamSignal(rich.output, renderState(), '/workspace')(failure);
        await interactiveGraphStreamSignal(plain.output, renderState(), '/workspace')(failure);

        // Then
        expect(rich.fallbackBytes).toEqual(['✗ ordinary-node: ordinary failure\n']);
        expect(plain.writes).toEqual(['✗ ordinary-node: ordinary failure\n']);
    });

    it('redacts graph render exceptions before stderr and fallback output', async () => {
        // Given
        const secret = 'sk-renderfailure123';
        const writes: string[] = [];
        const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        const output = {
            write: (text: string) => writes.push(text),
            writeTranscriptPart: () => {
                throw new Error(`render failed ${secret}`);
            },
        };

        // When
        const tap = interactiveGraphStreamSignal(output, renderState(), '/workspace');
        await tap(turnStarted('render-failure-node', 'turn'));
        await tap(graphDelta('render-failure-node', 'llm.text.delta', 'answer'));

        // Then
        expect(writes).toEqual(['Error: render failed [REDACTED_CREDENTIAL]\n']);
        expect(stderrWrite).toHaveBeenCalledWith(
            'Interactive graph render failed: render failed [REDACTED_CREDENTIAL]\n',
        );
        expect(JSON.stringify({ writes, stderr: stderrWrite.mock.calls })).not.toContain(secret);
        stderrWrite.mockRestore();
    });
});
