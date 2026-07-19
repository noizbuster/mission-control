import { AbgSignalSchema, AgentEventSchema } from '@mission-control/protocol';
import type { TranscriptPart } from '@mission-control/tui/state';
import type { ChatOutput } from './interactive-chat-io';
import { createProviderRenderState, type ProviderRenderState } from './interactive-coding-transcript-render-state';

const timestamp = '2026-07-17T00:00:00.000Z';

type TranscriptWrite = {
    readonly part: TranscriptPart;
    readonly fallbackText: string;
};

export type RichRecording = {
    readonly output: ChatOutput & { readonly writeTranscriptFallback: (text: string) => void };
    readonly rawWrites: string[];
    readonly fallbackBytes: string[];
    readonly transcriptWrites: TranscriptWrite[];
};

export function createRichRecording(showThinking = true): RichRecording {
    const rawWrites: string[] = [];
    const fallbackBytes: string[] = [];
    const transcriptWrites: TranscriptWrite[] = [];
    return {
        output: {
            write: (text) => rawWrites.push(text),
            writeTranscriptPart: (part, fallbackText) => {
                transcriptWrites.push({ part, fallbackText });
                fallbackBytes.push(fallbackText);
            },
            writeTranscriptFallback: (text) => fallbackBytes.push(text),
            isShowThinking: () => showThinking,
            isToolOutputExpanded: () => true,
        },
        rawWrites,
        fallbackBytes,
        transcriptWrites,
    };
}

export function createPlainRecording(): { readonly output: ChatOutput; readonly writes: string[] } {
    const writes: string[] = [];
    return { output: { write: (text) => writes.push(text), isToolOutputExpanded: () => true }, writes };
}

export function renderState(executionTurnId = 'outer-default'): ProviderRenderState {
    return createProviderRenderState(executionTurnId);
}

export function graphDelta(nodeId: string, type: 'llm.text.delta' | 'llm.reasoning.delta', delta: string) {
    return AbgSignalSchema.parse({
        type: 'emit',
        nodeId,
        event: { id: `${nodeId}-${type}-${delta}`, type, source: 'test', timestamp, payload: { delta } },
    });
}

export function turnStarted(nodeId: string, turnId: string) {
    return AbgSignalSchema.parse({
        type: 'emit',
        nodeId,
        event: { id: `${nodeId}-${turnId}-started`, type: 'llm.turn.started', source: 'test', timestamp },
    });
}

export function graphFailure(nodeId: string, message: string) {
    return AbgSignalSchema.parse({
        type: 'failure',
        nodeId,
        error: { message, retryable: false },
    });
}

export function turnCompleted(nodeId: string, text: string) {
    return AgentEventSchema.parse({
        type: 'model.call.completed',
        timestamp,
        abg: { nodeId, emit: { type: 'llm.turn.completed', payload: { text } } },
    });
}

export function toolCompleted(nodeId: string, payload: unknown) {
    return AgentEventSchema.parse({
        type: 'tool.completed',
        timestamp,
        abg: { nodeId, emit: { type: 'tool.completed', payload } },
    });
}

export const commandOutput = 'first line\nsecond line';

export const commandStructuredOutput = {
    kind: 'command_run',
    status: 'completed',
    command: ['pnpm', 'test'],
    cwd: '/workspace',
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: commandOutput,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutOriginalBytes: 22,
    stderrOriginalBytes: 0,
    stdoutReturnedBytes: 22,
    stderrReturnedBytes: 0,
    durationMs: 12,
} as const;

export const fileWriteStructuredOutput = {
    kind: 'file_write',
    operation: 'created',
    appliedFiles: ['notes.txt'],
} as const;
