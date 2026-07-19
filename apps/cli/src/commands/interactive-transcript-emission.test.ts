import type { ToolInvocationSettlement } from '@mission-control/core';
import { AbgSignalSchema, AgentEventSchema, ToolCallSchema, ToolResultSchema } from '@mission-control/protocol';
import type { TranscriptPart } from '@mission-control/tui/state';
import { describe, expect, it } from 'vitest';
import type { ChatOutput } from './interactive-chat-io';
import { interactiveGraphStreamSignal, renderInteractiveGraphDurableEvent } from './interactive-coding-graph-rendering';
import { renderInteractiveToolSettlement, renderProviderEnvelope } from './interactive-coding-provider-rendering';
import { renderToolPreview } from './interactive-coding-tool-preview';
import { createProviderRenderState, type ProviderRenderState } from './interactive-coding-transcript-render-state';
import { completedSettlement, providerEnvelope } from './interactive-transcript-emission-test-support';

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
});
