import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { AbgSignal } from '@mission-control/protocol';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JsonlSessionEventStore } from '../../../memory/jsonl-session-event-store.js';
import { type EvalInput, evalInputSchema } from '../../../tools/eval-schemas.js';
import { ToolRegistry } from '../../../tools/tool-registry.js';
import type { ToolRegistration } from '../../../tools/tool-registry-types.js';
import { projectAbgSignalToEvent } from '../../signals.js';
import { bridgeAdvertisementsToAiSdk, createAbgToolSettlementLedger } from './abg-tool-bridge.js';
import { runLlmActor } from './llm-actor-node.js';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const now = '2026-07-14T00:00:00.000Z';
const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('LLM actor eval observability', () => {
    it('executes raw eval input while redacting emitted and persisted proposal payloads', async () => {
        const secret = 'ordinary-eval-cell-secret-value';
        const rawInput: EvalInput = {
            cells: [{ language: 'py', code: `secret = ${JSON.stringify(secret)}\nprint(secret)` }],
        };
        let executedInput: EvalInput | undefined;
        const registration: ToolRegistration<EvalInput, { readonly ok: boolean }> = {
            name: 'eval',
            description: 'Capture eval input for observability testing.',
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
        const registry = new ToolRegistry();
        const advertisement = registry.register(registration);
        const settlementLedger = createAbgToolSettlementLedger();
        const tools = bridgeAdvertisementsToAiSdk(registry, [advertisement], { settlementLedger });
        const model = new MockLanguageModelV3({
            provider: 'test',
            modelId: 'eval-observability',
            doStream: async () => ({ stream: convertArrayToReadableStream(toolCallChunks(rawInput)) }),
        });
        const signals: AbgSignal[] = [];

        for await (const signal of runLlmActor({
            graphId: 'graph_eval_observability',
            nodeId: 'llm_actor',
            model,
            system: 'Run eval.',
            messages: [{ role: 'user', content: 'run eval' }],
            tools,
            now: () => now,
            settlementLedger,
        })) {
            signals.push(signal);
        }

        const proposal = signals.find(
            (signal) => signal.type === 'emit' && signal.event.type === 'llm.tool_call.proposed',
        );
        if (proposal === undefined) {
            throw new TypeError('eval proposal signal missing');
        }
        if (!('event' in proposal)) {
            throw new TypeError('eval proposal was not an emit signal');
        }
        const event = projectAbgSignalToEvent({
            graphId: 'graph_eval_observability',
            sessionId: 'session_eval_observability',
            timestamp: now,
            signal: proposal,
        });
        const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-eval-observability-'));
        tempDirs.push(dataDir);
        const store = await JsonlSessionEventStore.open({ sessionId: 'session_eval_observability', dataDir });
        await store.append(event);
        await store.close();
        const persisted = await readFile(join(dataDir, 'sessions', 'session_eval_observability.jsonl'), 'utf8');
        const digest = createHash('sha256').update(JSON.stringify(rawInput)).digest('hex');

        expect(executedInput).toEqual(rawInput);
        expect(proposal.event.payload).toMatchObject({
            toolName: 'eval',
            input: { redacted: true, sha256: digest },
        });
        for (const surface of [JSON.stringify(proposal), JSON.stringify(event), persisted]) {
            expect(surface).not.toContain(secret);
            expect(surface).not.toContain(rawInput.cells[0]?.code);
        }
    });
});

function toolCallChunks(input: EvalInput): LanguageModelV3StreamPart[] {
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
            usage: {
                inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 6, text: 6, reasoning: 0 },
            },
        },
    ];
}
