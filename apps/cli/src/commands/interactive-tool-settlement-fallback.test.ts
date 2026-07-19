import { describe, expect, it } from 'vitest';
import { renderGraphToolSettlement } from './interactive-coding-graph-tool-rendering';
import { renderInteractiveToolSettlement } from './interactive-coding-provider-rendering';
import { completedSettlement } from './interactive-transcript-emission-test-support';
import {
    commandOutput,
    commandStructuredOutput,
    createPlainRecording,
    createRichRecording,
    fileWriteStructuredOutput,
    renderState,
} from './interactive-transcript-fallback-test-support';

describe('fallback-only expanded tool settlement rendering', () => {
    it('allocates fresh FIFO occurrences for provider and graph settlements without previews', () => {
        // Given
        const recording = createRichRecording();
        const state = renderState('settlement-only-turn');

        // When
        renderInteractiveToolSettlement(
            recording.output,
            completedSettlement({
                toolCallId: 'gemini_call_0:0',
                toolName: 'repo.read',
                modelOutput: 'provider contents',
            }),
            state,
        );
        renderGraphToolSettlement({
            output: recording.output,
            state,
            payload: {
                toolCallId: 'gemini_call_0:0',
                toolName: 'repo.read',
                output: 'graph contents',
            },
            status: 'completed',
        });

        // Then
        expect(
            recording.transcriptWrites.map(({ part }) => ({
                id: part.id,
                toolCallId: 'toolCallId' in part ? part.toolCallId : undefined,
            })),
        ).toEqual([
            {
                id: 'tool:settlement-only-turn:gemini_call_0%3A0:occurrence:1',
                toolCallId: 'gemini_call_0:0',
            },
            {
                id: 'tool:settlement-only-turn:gemini_call_0%3A0:occurrence:2',
                toolCallId: 'gemini_call_0:0',
            },
        ]);
        expect(recording.rawWrites).toEqual([]);
    });

    it('keeps expanded provider command detail semantic while routing its summary to fallback only', () => {
        // Given
        const recording = createRichRecording();

        // When
        renderInteractiveToolSettlement(
            recording.output,
            completedSettlement({
                toolCallId: 'call-command',
                toolName: 'command.run',
                modelOutput: commandOutput,
                structuredOutput: commandStructuredOutput,
            }),
            renderState('provider-command-turn'),
        );

        // Then
        expect(recording.transcriptWrites.map(({ part }) => part)).toContainEqual(
            expect.objectContaining({
                id: 'tool:provider-command-turn:call-command:occurrence:1',
                type: 'command',
                detail: commandOutput,
                status: 'completed',
            }),
        );
        expect(recording.rawWrites).toEqual([]);
        expect(recording.fallbackBytes.at(-1)).toBe(`Command output for command.run\n${commandOutput}\n`);
    });

    it('keeps expanded provider file settlement summaries out of raw visual writes', () => {
        // Given
        const recording = createRichRecording();

        // When
        renderInteractiveToolSettlement(
            recording.output,
            completedSettlement({
                toolCallId: 'call-file',
                toolName: 'file.write',
                modelOutput: 'created notes.txt',
                structuredOutput: fileWriteStructuredOutput,
            }),
            renderState('provider-file-turn'),
        );

        // Then
        expect(recording.transcriptWrites.map(({ part }) => part)).toContainEqual(
            expect.objectContaining({
                id: 'tool:provider-file-turn:call-file:occurrence:1',
                type: 'block-tool',
                appliedFiles: ['notes.txt'],
            }),
        );
        expect(recording.rawWrites).toEqual([]);
        expect(recording.fallbackBytes).toEqual(['Created file: notes.txt\n', 'Created file: notes.txt\n']);
    });

    it('routes expanded graph command summaries through fallback only', () => {
        // Given
        const recording = createRichRecording();

        // When
        renderGraphToolSettlement({
            output: recording.output,
            state: renderState('graph-command-turn'),
            payload: { toolCallId: 'call-graph-command', toolName: 'command.run', output: commandOutput },
            status: 'completed',
        });

        // Then
        expect(recording.transcriptWrites.map(({ part }) => part)).toContainEqual(
            expect.objectContaining({
                id: 'tool:graph-command-turn:call-graph-command:occurrence:1',
                type: 'command',
                detail: commandOutput,
            }),
        );
        expect(recording.rawWrites).toEqual([]);
        expect(recording.fallbackBytes.at(-1)).toBe(`Command output for command.run\n${commandOutput}\n`);
    });

    it('redacts secrets from provider and graph semantic plus fallback-only command output', () => {
        // Given
        const secret = 'sk-expandedfallback123';
        const outputText = `first line\n${secret}`;
        const provider = createRichRecording();
        const graph = createRichRecording();

        // When
        renderInteractiveToolSettlement(
            provider.output,
            completedSettlement({ toolCallId: 'secret-provider', toolName: 'command.run', modelOutput: outputText }),
            renderState('secret-provider-turn'),
        );
        renderGraphToolSettlement({
            output: graph.output,
            state: renderState('secret-graph-turn'),
            payload: { toolCallId: 'secret-graph', toolName: 'command.run', output: outputText },
            status: 'completed',
        });

        // Then
        const rendered = JSON.stringify({ provider, graph });
        expect(rendered).toContain('[REDACTED_CREDENTIAL]');
        expect(rendered).not.toContain(secret);
    });

    it('preserves provider and graph expanded settlement fallback bytes exactly', () => {
        // Given
        const providerCommand = createPlainRecording();
        const providerFile = createPlainRecording();
        const graphCommand = createPlainRecording();
        const graphFile = createPlainRecording();

        // When
        renderInteractiveToolSettlement(
            providerCommand.output,
            completedSettlement({ toolCallId: 'plain-command', toolName: 'command.run', modelOutput: commandOutput }),
            renderState('plain-provider-command-turn'),
        );
        renderInteractiveToolSettlement(
            providerFile.output,
            completedSettlement({
                toolCallId: 'plain-file',
                toolName: 'file.write',
                modelOutput: 'created',
                structuredOutput: fileWriteStructuredOutput,
            }),
            renderState('plain-provider-file-turn'),
        );
        renderGraphToolSettlement({
            output: graphCommand.output,
            state: renderState('plain-graph-command-turn'),
            payload: { toolCallId: 'plain-graph-command', toolName: 'command.run', output: commandOutput },
            status: 'completed',
        });
        renderGraphToolSettlement({
            output: graphFile.output,
            state: renderState('plain-graph-file-turn'),
            payload: {
                toolCallId: 'plain-graph-file',
                toolName: 'file.write',
                output: 'created',
                structuredOutput: fileWriteStructuredOutput,
            },
            status: 'completed',
        });

        // Then
        const commandBytes = `Command output for command.run: first line · second line\nCommand output for command.run\n${commandOutput}\n`;
        expect({
            providerCommand: providerCommand.writes.join(''),
            providerFile: providerFile.writes.join(''),
            graphCommand: graphCommand.writes.join(''),
            graphFile: graphFile.writes.join(''),
        }).toEqual({
            providerCommand: commandBytes,
            providerFile: 'Created file: notes.txt\nCreated file: notes.txt\n',
            graphCommand: commandBytes,
            graphFile: 'Created file: notes.txt\nCreated file: notes.txt\n',
        });
    });
});
