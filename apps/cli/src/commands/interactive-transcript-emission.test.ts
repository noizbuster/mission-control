import type { ToolInvocationSettlement } from '@mission-control/core';
import { AbgSignalSchema, AgentEventSchema, ToolCallSchema, ToolResultSchema } from '@mission-control/protocol';
import { aggregateToolCallsForMessage, type TranscriptPart } from '@mission-control/tui/state';
import { describe, expect, it } from 'vitest';
import type { ChatOutput } from './interactive-chat-io';
import { interactiveGraphStreamSignal, renderInteractiveGraphDurableEvent } from './interactive-coding-graph-rendering';
import { renderInteractiveToolSettlement, renderProviderEnvelope } from './interactive-coding-provider-rendering';
import { renderToolPreview } from './interactive-coding-tool-preview';
import { createProviderRenderState, type ProviderRenderState } from './interactive-coding-transcript-render-state';
import { completedSettlement, providerEnvelope } from './interactive-transcript-emission-test-support';
import { graphDelta, turnStarted } from './interactive-transcript-fallback-test-support';

const timestamp = '2026-07-17T00:00:00.000Z';
const hostileDisplayPayload =
    'credential sk-displayblocker123 OSC:\u001b]52;c;UE9D\u0007 C0:\u0001 C1:\u009b CR:\r TAB:\t BIDI:\u202e';
const sanitizedDisplayPayload =
    'credential [REDACTED_CREDENTIAL] OSC:\\u{001B}]52;c;UE9D\\u{0007} C0:\\u{0001} C1:\\u{009B} CR:\\u{000D} TAB:\\u{0009} BIDI:\\u{202E}';

type TranscriptWrite = {
    readonly part: TranscriptPart;
    readonly fallbackText: string;
};

type RecordingOutput = ChatOutput & {
    writeTranscriptPart(part: TranscriptPart, fallbackText: string): void;
};

function createRecordingOutput(): {
    readonly output: RecordingOutput;
    readonly textWrites: string[];
    readonly transcriptWrites: TranscriptWrite[];
    readonly statuses: string[];
} {
    const textWrites: string[] = [];
    const transcriptWrites: TranscriptWrite[] = [];
    const statuses: string[] = [];
    return {
        output: {
            write: (text) => textWrites.push(text),
            writeTranscriptPart: (part, fallbackText) => transcriptWrites.push({ part, fallbackText }),
            setAgentStatus: (text) => statuses.push(text),
        },
        textWrites,
        transcriptWrites,
        statuses,
    };
}

function renderState(): ProviderRenderState {
    return createProviderRenderState('outer-emission');
}

// biome-ignore format: Keep the Given/When/Then contract matrix compact enough to review as one test surface.
describe('interactive typed transcript emission', () => {
    it('emits assistant streaming and completion parts with the lane-qualified provider request ID', () => {
        // Given
        const recording = createRecordingOutput();
        const state = renderState();

        // When
        renderProviderEnvelope(recording.output, state, providerEnvelope({
            kind: 'text_delta', requestId: 'request-assistant', sequence: 1, delta: 'partial',
        }));
        renderProviderEnvelope(recording.output, state, providerEnvelope({
            kind: 'response_completed', requestId: 'request-assistant', sequence: 2,
            message: { messageId: 'message-assistant', role: 'assistant', content: 'partial answer' },
            finishReason: 'stop',
        }));

        // Then
        expect(recording.transcriptWrites.map(({ part }) => part)).toEqual([
            expect.objectContaining({ id: 'provider:outer-emission:request-assistant:assistant', type: 'assistant', text: 'partial', status: 'streaming', requestId: 'request-assistant' }),
            expect.objectContaining({ id: 'provider:outer-emission:request-assistant:assistant', type: 'assistant', text: 'partial answer', status: 'completed', messageId: 'message-assistant', requestId: 'request-assistant' }),
        ]);
    });

    it('emits reasoning streaming and completion parts with the lane-qualified provider request ID', () => {
        // Given
        const recording = createRecordingOutput();
        const state = renderState();

        // When
        renderProviderEnvelope(recording.output, state, providerEnvelope({
            kind: 'reasoning_delta', requestId: 'request-reasoning', sequence: 1, delta: 'inspect',
        }));
        renderProviderEnvelope(recording.output, state, providerEnvelope({
            kind: 'reasoning_completed', requestId: 'request-reasoning', sequence: 2, text: 'inspect evidence',
        }));

        // Then
        expect(recording.transcriptWrites.map(({ part }) => part)).toEqual([
            expect.objectContaining({ id: 'provider:outer-emission:request-reasoning:reasoning', type: 'reasoning', text: 'inspect', status: 'streaming', requestId: 'request-reasoning' }),
            expect.objectContaining({ id: 'provider:outer-emission:request-reasoning:reasoning', type: 'reasoning', text: 'inspect evidence', status: 'completed', requestId: 'request-reasoning' }),
        ]);
    });

    it('keeps the tool-call ID stable from preview through settlement', async () => {
        // Given
        const recording = createRecordingOutput();
        const toolCall = ToolCallSchema.parse({
            toolCallId: 'call-read', toolName: 'repo.read', argumentsJson: JSON.stringify({ path: 'README.md' }),
        });

        // When
        const state = renderState();
        await renderToolPreview(toolCall, recording.output, { state });
        renderInteractiveToolSettlement(recording.output, completedSettlement({
            toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, modelOutput: 'README contents',
        }), state);

        // Then
        expect(recording.transcriptWrites.map(({ part }) => part)).toEqual([
            expect.objectContaining({ id: 'tool:outer-emission:call-read:occurrence:1', type: 'inline-tool', toolCallId: 'call-read', toolName: 'repo.read', status: 'pending' }),
            expect.objectContaining({ id: 'tool:outer-emission:call-read:occurrence:1', type: 'inline-tool', toolCallId: 'call-read', toolName: 'repo.read', status: 'completed', output: 'README contents' }),
        ]);
    });

    it('retains multiline command detail and completion metadata', () => {
        // Given
        const recording = createRecordingOutput();
        const detail = '$ pnpm test\nstatus: completed exit: 0\nstdout:\nfirst line\nsecond line\n';

        // When
        renderInteractiveToolSettlement(recording.output, completedSettlement({
            toolCallId: 'call-command',
            toolName: 'command.run',
            modelOutput: detail,
            structuredOutput: {
                kind: 'command_run', status: 'completed', command: ['pnpm', 'test'], cwd: '/workspace',
                exitCode: 0, signal: null, timedOut: false, stdout: 'first line\nsecond line\n', stderr: '',
                stdoutTruncated: false, stderrTruncated: false, stdoutOriginalBytes: 23, stderrOriginalBytes: 0,
                stdoutReturnedBytes: 23, stderrReturnedBytes: 0, durationMs: 12,
            },
        }), renderState());

        // Then
        expect(recording.transcriptWrites.map(({ part }) => part)).toContainEqual(expect.objectContaining({
            id: 'tool:outer-emission:call-command:occurrence:1', type: 'command', toolCallId: 'call-command', command: 'pnpm test', detail, exitCode: 0, status: 'completed',
        }));
    });

    it('emits the full task result as subagent content', () => {
        // Given
        const recording = createRecordingOutput();
        const fullResult = `Child completed the requested review.\nEvidence:\n${'verified-result '.repeat(20)}\nVerification passed.`;

        // When
        renderInteractiveToolSettlement(recording.output, completedSettlement({
            toolCallId: 'call-task', toolName: 'task', modelOutput: fullResult,
        }), renderState());

        // Then
        expect(recording.transcriptWrites.map(({ part }) => part)).toContainEqual(expect.objectContaining({
            id: 'tool:outer-emission:call-task:occurrence:1', type: 'subagent', toolCallId: 'call-task', text: fullResult, status: 'completed',
        }));
    });

    it('emits graph decisions with stable node identity', () => {
        // Given
        const recording = createRecordingOutput();
        const event = AgentEventSchema.parse({
            type: 'decision.selected', timestamp, message: 'route to planner', abg: { nodeId: 'intent-gate' },
        });

        // When
        renderInteractiveGraphDurableEvent(recording.output, renderState(), event);

        // Then
        expect(recording.transcriptWrites.map(({ part }) => part)).toContainEqual(expect.objectContaining({
            id: 'graph:outer-emission:occurrence:1', type: 'event', eventType: 'decision.selected', status: 'informational',
        }));
    });

    it('emits workflow graph events with the embedded event identity', async () => {
        // Given
        const recording = createRecordingOutput();
        const signal = AbgSignalSchema.parse({
            type: 'emit', nodeId: 'workflow-router',
            event: { id: 'event-workflow-transition', type: 'workflow.transitioned', source: 'test', timestamp, payload: { target: 'planner' } },
        });

        // When
        await interactiveGraphStreamSignal(recording.output, renderState(), '/workspace')(signal);

        // Then
        expect(recording.transcriptWrites.map(({ part }) => part)).toContainEqual(expect.objectContaining({
            id: 'graph:outer-emission:event:event-workflow-transition', type: 'event', eventId: 'event-workflow-transition', eventType: 'workflow.transitioned', timestamp,
        }));
    });

    it('emits running status with stable graph node identity', () => {
        // Given
        const recording = createRecordingOutput();
        const event = AgentEventSchema.parse({
            type: 'attempt.started', timestamp, abg: { nodeId: 'verify-wave', attempt: 1 },
        });

        // When
        renderInteractiveGraphDurableEvent(recording.output, renderState(), event);

        // Then
        expect(recording.statuses).toEqual(['Verifying…']);
        expect(recording.transcriptWrites.map(({ part }) => part)).toContainEqual(expect.objectContaining({
            id: 'graph:outer-emission:occurrence:1', type: 'status', status: 'running',
        }));
    });

    it('sanitizes dynamic graph node and tool names passed to setAgentStatus', async () => {
        // Given
        const recording = createRecordingOutput();
        const state = renderState();
        const tap = interactiveGraphStreamSignal(recording.output, state, '/workspace');

        // When
        await tap(AbgSignalSchema.parse({ type: 'started', nodeId: hostileDisplayPayload }));
        await tap(
            AbgSignalSchema.parse({
                type: 'emit',
                nodeId: 'tool-node',
                event: {
                    id: 'event-tool-started-hostile',
                    type: 'tool.started',
                    source: 'test',
                    timestamp,
                    payload: { toolName: hostileDisplayPayload },
                },
            }),
        );
        await tap(
            AbgSignalSchema.parse({
                type: 'emit',
                nodeId: 'tool-node',
                event: {
                    id: 'event-tool-proposed-hostile',
                    type: 'llm.tool_call.proposed',
                    source: 'test',
                    timestamp,
                    payload: {
                        input: { value: 'raw execution input' },
                        toolCallId: 'raw-tool-call-id',
                        toolName: hostileDisplayPayload,
                    },
                },
            }),
        );

        // Then
        expect(recording.statuses).toEqual([
            `${sanitizedDisplayPayload}…`,
            `Running ${sanitizedDisplayPayload}...`,
            `Calling ${sanitizedDisplayPayload}...`,
        ]);
        expect(recording.transcriptWrites).toContainEqual(
            expect.objectContaining({ part: expect.objectContaining({ toolCallId: 'raw-tool-call-id' }) }),
        );
    });

    it('emits redacted graph errors with failed status', async () => {
        // Given
        const recording = createRecordingOutput();
        const state = renderState();
        const secret = 'sk-grapherror123';
        const event = AgentEventSchema.parse({
            type: 'model.call.failed', timestamp,
            abg: { nodeId: 'answer-node', emit: { type: 'llm.error', payload: { error: `provider rejected ${secret}` } } },
        });

        // When
        await interactiveGraphStreamSignal(recording.output, state, '/workspace')(
            AbgSignalSchema.parse({
                type: 'emit',
                nodeId: 'answer-node',
                event: {
                    id: 'event-answer-error',
                    type: 'llm.turn.started',
                    source: 'test',
                    timestamp,
                },
            }),
        );
        renderInteractiveGraphDurableEvent(recording.output, state, event);

        // Then
        expect(recording.transcriptWrites.map(({ part }) => part)).toContainEqual(expect.objectContaining({
            id: 'graph:outer-emission:event-answer-error:error', type: 'error', text: 'provider rejected [REDACTED_CREDENTIAL]', error: 'provider rejected [REDACTED_CREDENTIAL]', status: 'failed',
        }));
        expect(JSON.stringify(recording.transcriptWrites)).not.toContain(secret);
    });

    it('emits redacted failed tool data under the tool-call ID', () => {
        // Given
        const recording = createRecordingOutput();
        const secret = 'sk-toolerror123';
        const settlement = {
            toolCallId: 'call-failed',
            toolName: 'repo.read',
            result: ToolResultSchema.parse({
                toolCallId: 'call-failed', status: 'failed',
                error: { code: 'tool_failed', message: `provider rejected ${secret}`, retryable: false },
            }),
            events: [],
        } satisfies ToolInvocationSettlement;

        // When
        renderInteractiveToolSettlement(recording.output, settlement, renderState());

        // Then
        expect(recording.transcriptWrites.map(({ part }) => part)).toContainEqual(expect.objectContaining({
            id: 'tool:outer-emission:call-failed:occurrence:1', type: 'inline-tool', toolCallId: 'call-failed', status: 'failed', error: 'provider rejected [REDACTED_CREDENTIAL]',
        }));
        expect(JSON.stringify(recording.transcriptWrites)).not.toContain(secret);
    });

    it('threads each tool messageId to the preceding assistant attribution key', async () => {
        // Given
        const recording = createRecordingOutput();
        const state = renderState();
        const firstTool = ToolCallSchema.parse({
            toolCallId: 'call-a', toolName: 'repo.read', argumentsJson: JSON.stringify({ path: 'a.md' }),
        });
        const secondTool = ToolCallSchema.parse({
            toolCallId: 'call-b', toolName: 'repo.read', argumentsJson: JSON.stringify({ path: 'b.md' }),
        });

        // When
        renderProviderEnvelope(recording.output, state, providerEnvelope({
            kind: 'response_completed', requestId: 'request-a', sequence: 1,
            message: { messageId: 'message-a', role: 'assistant', content: 'first' },
            finishReason: 'tool_calls',
        }));
        await renderToolPreview(firstTool, recording.output, { state });
        renderInteractiveToolSettlement(recording.output, completedSettlement({
            toolCallId: firstTool.toolCallId, toolName: firstTool.toolName, modelOutput: 'a',
        }), state);
        renderProviderEnvelope(recording.output, state, providerEnvelope({
            kind: 'response_completed', requestId: 'request-b', sequence: 2,
            message: { messageId: 'message-b', role: 'assistant', content: 'second' },
            finishReason: 'tool_calls',
        }));
        await renderToolPreview(secondTool, recording.output, { state });
        renderInteractiveToolSettlement(recording.output, completedSettlement({
            toolCallId: secondTool.toolCallId, toolName: secondTool.toolName, modelOutput: 'b',
        }), state);

        // Then
        const toolParts = recording.transcriptWrites
            .map(({ part }) => part)
            .filter((part) => part.type === 'inline-tool');
        expect(toolParts).toEqual([
            expect.objectContaining({ toolCallId: 'call-a', status: 'pending', messageId: 'message-a' }),
            expect.objectContaining({ toolCallId: 'call-a', status: 'completed', messageId: 'message-a' }),
            expect.objectContaining({ toolCallId: 'call-b', status: 'pending', messageId: 'message-b' }),
            expect.objectContaining({ toolCallId: 'call-b', status: 'completed', messageId: 'message-b' }),
        ]);
    });

    it('aggregates emitted tool parts per assistant messageId without cross-turn leakage', async () => {
        // Given
        const recording = createRecordingOutput();
        const state = renderState();
        const toolsA = [
            ToolCallSchema.parse({
                toolCallId: 'call-a-read', toolName: 'repo.read', argumentsJson: JSON.stringify({ path: 'a.md' }),
            }),
            ToolCallSchema.parse({
                toolCallId: 'call-a-list', toolName: 'repo.list', argumentsJson: JSON.stringify({ path: '.' }),
            }),
            ToolCallSchema.parse({
                toolCallId: 'call-a-fail', toolName: 'repo.read', argumentsJson: JSON.stringify({ path: 'missing.md' }),
            }),
        ] as const;
        const toolB = ToolCallSchema.parse({
            toolCallId: 'call-b-read', toolName: 'repo.read', argumentsJson: JSON.stringify({ path: 'b.md' }),
        });

        // When
        renderProviderEnvelope(recording.output, state, providerEnvelope({
            kind: 'response_completed', requestId: 'request-a', sequence: 1,
            message: { messageId: 'message-a', role: 'assistant', content: 'first turn' },
            finishReason: 'tool_calls',
        }));
        for (const tool of toolsA) {
            await renderToolPreview(tool, recording.output, { state });
        }
        renderInteractiveToolSettlement(recording.output, completedSettlement({
            toolCallId: toolsA[0].toolCallId, toolName: toolsA[0].toolName, modelOutput: 'a-read',
        }), state);
        renderInteractiveToolSettlement(recording.output, completedSettlement({
            toolCallId: toolsA[1].toolCallId, toolName: toolsA[1].toolName, modelOutput: 'a-list',
        }), state);
        renderInteractiveToolSettlement(recording.output, {
            toolCallId: toolsA[2].toolCallId,
            toolName: toolsA[2].toolName,
            result: ToolResultSchema.parse({
                toolCallId: toolsA[2].toolCallId,
                status: 'failed',
                error: { code: 'tool_failed', message: 'not found', retryable: false },
            }),
            events: [],
        } satisfies ToolInvocationSettlement, state);

        renderProviderEnvelope(recording.output, state, providerEnvelope({
            kind: 'response_completed', requestId: 'request-b', sequence: 2,
            message: { messageId: 'message-b', role: 'assistant', content: 'second turn' },
            finishReason: 'tool_calls',
        }));
        await renderToolPreview(toolB, recording.output, { state });
        renderInteractiveToolSettlement(recording.output, completedSettlement({
            toolCallId: toolB.toolCallId, toolName: toolB.toolName, modelOutput: 'b-read',
        }), state);

        // Then
        const emittedParts = recording.transcriptWrites.map(({ part }) => part);
        const settledTools = emittedParts.filter(
            (part) =>
                (part.type === 'inline-tool' || part.type === 'command' || part.type === 'subagent') &&
                (part.status === 'completed' || part.status === 'failed'),
        );
        expect(settledTools).toEqual([
            expect.objectContaining({ toolCallId: 'call-a-read', status: 'completed', messageId: 'message-a', toolName: 'repo.read' }),
            expect.objectContaining({ toolCallId: 'call-a-list', status: 'completed', messageId: 'message-a', toolName: 'repo.list' }),
            expect.objectContaining({ toolCallId: 'call-a-fail', status: 'failed', messageId: 'message-a', toolName: 'repo.read' }),
            expect.objectContaining({ toolCallId: 'call-b-read', status: 'completed', messageId: 'message-b', toolName: 'repo.read' }),
        ]);

        const aggA = aggregateToolCallsForMessage(emittedParts, 'message-a');
        const aggB = aggregateToolCallsForMessage(emittedParts, 'message-b');
        expect(aggA.totalCount).toBe(2);
        expect(aggA.failedCount).toBe(1);
        expect(aggA.byToolName.get('repo.read')).toBe(1);
        expect(aggA.byToolName.get('repo.list')).toBe(1);
        expect(aggB.totalCount).toBe(1);
        expect(aggB.failedCount).toBe(0);
        expect(aggB.byToolName.get('repo.read')).toBe(1);
        expect(aggB.byToolName.has('repo.list')).toBe(false);
        expect(aggA.totalCount + aggA.failedCount).toBe(3);
    });

    it('uses the graph assistant part id when messageId and requestId are absent', async () => {
        // Given
        const recording = createRecordingOutput();
        const state = renderState();
        const tap = interactiveGraphStreamSignal(recording.output, state, '/workspace');
        const toolCall = ToolCallSchema.parse({
            toolCallId: 'call-graph', toolName: 'repo.read', argumentsJson: JSON.stringify({ path: 'g.md' }),
        });

        // When
        await tap(turnStarted('answer-node', 'turn-one'));
        await tap(graphDelta('answer-node', 'llm.text.delta', 'graph answer'));
        await renderToolPreview(toolCall, recording.output, { state });
        renderInteractiveToolSettlement(recording.output, completedSettlement({
            toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, modelOutput: 'graph tool',
        }), state);

        // Then
        const assistantPartId = 'graph:outer-emission:answer-node-turn-one-started:assistant';
        expect(recording.transcriptWrites.map(({ part }) => part)).toContainEqual(expect.objectContaining({
            id: assistantPartId, type: 'assistant', status: 'streaming',
        }));
        expect(recording.transcriptWrites.map(({ part }) => part)).toContainEqual(expect.objectContaining({
            toolCallId: 'call-graph', type: 'inline-tool', status: 'pending', messageId: assistantPartId,
        }));
        expect(recording.transcriptWrites.map(({ part }) => part)).toContainEqual(expect.objectContaining({
            toolCallId: 'call-graph', type: 'inline-tool', status: 'completed', messageId: assistantPartId,
        }));
    });

    it('leaves tool messageId unset when no assistant attribution exists yet', async () => {
        // Given
        const recording = createRecordingOutput();
        const state = renderState();
        const toolCall = ToolCallSchema.parse({
            toolCallId: 'call-early', toolName: 'repo.read', argumentsJson: JSON.stringify({ path: 'early.md' }),
        });

        // When
        await renderToolPreview(toolCall, recording.output, { state });
        renderInteractiveToolSettlement(recording.output, completedSettlement({
            toolCallId: toolCall.toolCallId, toolName: toolCall.toolName, modelOutput: 'early',
        }), state);

        // Then
        for (const part of recording.transcriptWrites.map(({ part }) => part).filter((entry) => entry.type === 'inline-tool')) {
            expect(part).not.toHaveProperty('messageId');
        }
    });

    it('stamps toolName on settled command parts', () => {
        // Given
        const recording = createRecordingOutput();
        const state = renderState();
        renderProviderEnvelope(recording.output, state, providerEnvelope({
            kind: 'response_completed', requestId: 'request-cmd', sequence: 1,
            message: { messageId: 'message-cmd', role: 'assistant', content: 'run it' },
            finishReason: 'tool_calls',
        }));

        // When
        renderInteractiveToolSettlement(recording.output, completedSettlement({
            toolCallId: 'call-command-named',
            toolName: 'command.run',
            modelOutput: '$ pnpm test\nstatus: completed exit: 0\n',
            structuredOutput: {
                kind: 'command_run', status: 'completed', command: ['pnpm', 'test'], cwd: '/workspace',
                exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '',
                stdoutTruncated: false, stderrTruncated: false, stdoutOriginalBytes: 0, stderrOriginalBytes: 0,
                stdoutReturnedBytes: 0, stderrReturnedBytes: 0, durationMs: 1,
            },
        }), state);

        // Then
        expect(recording.transcriptWrites.map(({ part }) => part)).toContainEqual(expect.objectContaining({
            type: 'command', toolCallId: 'call-command-named', toolName: 'command.run', messageId: 'message-cmd',
        }));
    });
});
