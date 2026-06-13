import {
    JsonlSessionEventStore,
    missionControlDataDirEnvKey,
    type ProviderAdapter,
    type ProviderTurnRequest,
    projectJsonlSessionReplayPrefix,
} from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { writeSessionEvents } from './session-test-support.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function tempRoot(roots: string[], prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    return root;
}

export function stubDataDirEnv(dataDir: string): string {
    process.env[missionControlDataDirEnvKey] = dataDir;
    return dataDir;
}

export async function seedCompactionSession(
    dataDir: string,
    sessionId: string,
    options: { readonly firstTask?: string } = {},
): Promise<void> {
    await writeSessionEvents({
        dataDir,
        sessionId,
        events: [
            promptPromoted(sessionId, 'input_1', 'message_1', options.firstTask ?? 'first task'),
            providerCompleted(sessionId, 'first result'),
            promptPromoted(sessionId, 'input_2', 'message_2', 'second task'),
            providerCompleted(sessionId, 'second result'),
            promptPromoted(sessionId, 'input_3', 'message_3', 'third task'),
            providerCompleted(sessionId, 'third result'),
        ],
    });
}

export async function seedCompactedSession(dataDir: string, sessionId: string): Promise<void> {
    await seedCompactionSession(dataDir, sessionId, {
        firstTask: 'OLD_PROMPT_SHOULD_BE_PRUNED',
    });
    const store = await JsonlSessionEventStore.open({
        sessionId,
        dataDir,
        now: fixedNow,
        createEventId: (_event, sequence) => `${sessionId}_${sequence}`,
    });
    try {
        await store.compact({
            sessionId,
            timestamp: fixedNow(),
            message: 'compacted older history',
            summary: 'COMPACTION_SUMMARY_SHOULD_BE_VISIBLE',
            boundaryEntryId: `${sessionId}_3_model_call_completed`,
            firstKeptEntryId: `${sessionId}_2_prompt_promoted`,
            boundarySequence: 3,
            firstKeptSequence: 2,
        });
    } finally {
        await store.close();
    }
}

export function promptPromoted(sessionId: string, inputId: string, messageId: string, message: string): AgentEvent {
    return {
        type: 'prompt.promoted',
        timestamp: '2026-06-13T00:00:01.000Z',
        sessionId,
        message,
        transcript: {
            inputId,
            messageId,
            delivery: 'queue',
        },
    };
}

export function providerCompleted(sessionId: string, message: string): AgentEvent {
    return {
        type: 'model.call.completed',
        timestamp: '2026-06-13T00:00:02.000Z',
        sessionId,
        providerStreamChunk: {
            kind: 'response_completed',
            requestId: `request_${sessionId}`,
            sequence: 1,
            message: {
                messageId: `assistant_${message.replaceAll(' ', '_')}`,
                role: 'assistant',
                content: message,
            },
            finishReason: 'stop',
        },
    };
}

export function captureSummaryProvider(requests: ProviderTurnRequest[], summary: string): ProviderAdapter {
    return captureSequentialProvider(requests, [summary]);
}

export function captureSequentialProvider(
    requests: ProviderTurnRequest[],
    responses: readonly string[],
): ProviderAdapter {
    let index = 0;
    return {
        async *streamTurn(request: ProviderTurnRequest) {
            requests.push(request);
            const content = responses[index] ?? responses.at(-1) ?? 'done';
            index += 1;
            yield {
                kind: 'response_completed' as const,
                requestId: request.requestId,
                sequence: 1,
                message: {
                    messageId: `message_${request.turnId}`,
                    role: 'assistant' as const,
                    content,
                },
                finishReason: 'stop' as const,
            };
        },
    };
}

export function captureFailingProvider(): ProviderAdapter {
    return {
        async *streamTurn(request: ProviderTurnRequest) {
            yield {
                kind: 'response_failed' as const,
                requestId: request.requestId,
                sequence: 1,
                error: {
                    code: 'unknown' as const,
                    message: 'summary provider failed',
                    retryable: false,
                },
            };
        },
    };
}

export function captureWaitingProvider(): ProviderAdapter {
    return {
        async *streamTurn(_request: ProviderTurnRequest, context: { readonly signal: AbortSignal }) {
            await new Promise<void>((_resolve, reject) => {
                const abort = () => {
                    context.signal.removeEventListener('abort', abort);
                    reject(new Error('aborted'));
                };
                context.signal.addEventListener('abort', abort, { once: true });
            });
            throw new Error('unreachable');
        },
    };
}

export async function readReplay(dataDir: string, sessionId: string) {
    return projectJsonlSessionReplayPrefix({
        sessionId,
        contents: await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8'),
    });
}

export function fixedNow(): string {
    return '2026-06-13T00:00:00.000Z';
}
