import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JsonlSessionEventStore } from '../memory/jsonl-session-event-store';
import { createObservabilityRedactor } from '../providers/observability-redactor';
import { type EvalInput, evalInputSchema } from '../tools/eval-schemas';
import { ToolRegistry } from '../tools/tool-registry';
import type { ToolRegistration } from '../tools/tool-registry-types';
import { createCodingAgentGraph } from './coding-agent-graph';
import { createCodingAgentNodeRegistry } from './coding-agent-registry';
import { runAbgGraph } from './graph-runner';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = '2026-07-13T00:00:00.000Z';

describe('graph final message observability', () => {
    it('redacts graph metadata returned by the exported runner', async () => {
        // Given
        const secret = ['sk', 'direct', 'graphsecret123'].join('-');

        // When
        const result = await runAbgGraph({
            graph: {
                id: `graph-${secret}`,
                entryNodeId: 'finish',
                nodes: [{ id: 'finish', kind: 'action' }],
                edges: [],
                rules: [],
                policies: [],
            },
            sessionId: 'session_direct_graph_redaction',
            now: () => NOW,
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
        });
        const observable = JSON.stringify(result);

        // Then
        expect(observable).toContain('[REDACTED_CREDENTIAL]');
        expect(observable).not.toContain(secret);
    });

    it('returns redacted final messages while retaining ordinary assistant text', async () => {
        // Given
        const knownCredential = ['known', 'graph', 'final', 'credential'].join('_');
        const chunks: LanguageModelV3StreamPart[] = [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text_final' },
            { type: 'text-delta', id: 'text_final', delta: `keep-this-answer ${knownCredential}` },
            { type: 'text-end', id: 'text_final' },
            {
                type: 'finish',
                finishReason: { unified: 'stop', raw: undefined },
                usage: {
                    inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 4, text: 4, reasoning: 0 },
                },
            },
        ];
        const model = new MockLanguageModelV3({
            provider: 'test',
            modelId: 'graph-final-redaction',
            doStream: async () => ({ stream: convertArrayToReadableStream(chunks) }),
        });

        // When
        const result = await runAbgGraph({
            graph: createCodingAgentGraph({ model: { providerID: 'test', modelID: 'graph-final-redaction' } }),
            sessionId: 'session_graph_final_redaction',
            now: () => NOW,
            modelProviderSelection: { providerID: 'test', modelID: 'graph-final-redaction' },
            registry: createCodingAgentNodeRegistry(),
            resolveSdkModel: () => model,
            initialMessages: [{ role: 'user', content: 'return a redacted answer' }],
            observabilityRedactor: createObservabilityRedactor({ secrets: [knownCredential] }),
        });
        const observable = JSON.stringify(result.finalMessages);

        // Then
        expect(result.status).toBe('completed');
        expect(observable).toContain('keep-this-answer');
        expect(observable).toContain('[REDACTED_CREDENTIAL]');
        expect(observable).not.toContain(knownCredential);
    });

    it('redacts eval source from graph results and replay without changing execution or provider history', async () => {
        // Given
        const secret = 'ordinary-eval-final-message-secret';
        const rawInput: EvalInput = {
            cells: [{ language: 'py', code: `secret = ${JSON.stringify(secret)}\nprint(secret)` }],
        };
        let executedInput: EvalInput | undefined;
        const registration: ToolRegistration<EvalInput, { readonly ok: boolean }> = {
            name: 'eval',
            description: 'Capture eval input for graph observability testing.',
            capabilityClasses: ['bash.run'],
            parametersJsonSchema: { type: 'object' },
            inputSchema: evalInputSchema,
            outputSchema: z.object({ ok: z.boolean() }),
            outputLimit: { maxModelOutputChars: 1_000 },
            execute: async (input) => {
                executedInput = input;
                return { ok: true };
            },
            toModelOutput: () => 'ok',
        };
        const toolRegistry = new ToolRegistry();
        toolRegistry.register(registration);
        let turn = 0;
        const model = new MockLanguageModelV3({
            provider: 'test',
            modelId: 'eval-final-message-redaction',
            doStream: async () => {
                turn += 1;
                return {
                    stream: convertArrayToReadableStream(
                        turn === 1 ? evalToolCallChunks(rawInput) : finalTextChunks('Eval complete.'),
                    ),
                };
            },
        });
        const sessionId = 'session_eval_final_message_redaction';
        const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-eval-final-message-'));

        try {
            // When
            const result = await runAbgGraph({
                graph: createCodingAgentGraph({
                    model: { providerID: 'test', modelID: 'eval-final-message-redaction' },
                }),
                sessionId,
                now: () => NOW,
                modelProviderSelection: { providerID: 'test', modelID: 'eval-final-message-redaction' },
                registry: createCodingAgentNodeRegistry(),
                resolveSdkModel: () => model,
                toolRegistry,
                initialMessages: [{ role: 'user', content: 'run eval then finish' }],
            });
            const store = await JsonlSessionEventStore.open({ sessionId, dataDir, now: () => NOW });
            for (const event of result.events) {
                await store.append(event);
            }
            await store.close();
            const rawJsonl = await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8');
            const reopened = await JsonlSessionEventStore.open({ sessionId, dataDir });
            const replayedEvents = await reopened.getEvents(sessionId);
            await reopened.close();
            const digest = createHash('sha256').update(JSON.stringify(rawInput)).digest('hex');
            const observableSurfaces = [
                JSON.stringify(result.finalMessages),
                JSON.stringify(result.events),
                rawJsonl,
                JSON.stringify(replayedEvents),
            ];

            // Then
            expect(result.status).toBe('completed');
            expect(executedInput).toEqual(rawInput);
            expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain(secret);
            expect(result.finalMessages).toContainEqual({
                role: 'assistant',
                content: expect.arrayContaining([
                    expect.objectContaining({
                        type: 'tool-call',
                        toolName: 'eval',
                        input: { redacted: true, sha256: digest },
                    }),
                ]),
            });
            for (const surface of observableSurfaces) {
                expect(surface).not.toContain(secret);
                expect(surface).not.toContain(rawInput.cells[0]?.code);
            }
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });
});

function evalToolCallChunks(input: EvalInput): LanguageModelV3StreamPart[] {
    const serialized = JSON.stringify(input);
    return [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-input-start', id: 'call_eval', toolName: 'eval' },
        { type: 'tool-input-delta', id: 'call_eval', delta: serialized },
        { type: 'tool-input-end', id: 'call_eval' },
        { type: 'tool-call', toolCallId: 'call_eval', toolName: 'eval', input: serialized },
        {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage: usage(),
        },
    ];
}

function finalTextChunks(text: string): LanguageModelV3StreamPart[] {
    return [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text_final' },
        { type: 'text-delta', id: 'text_final', delta: text },
        { type: 'text-end', id: 'text_final' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: usage() },
    ];
}

function usage() {
    return {
        inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 6, text: 6, reasoning: 0 },
    };
}
