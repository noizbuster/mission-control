/**
 * LLMActor node (ABG §10.1) — wraps a Vercel AI SDK `streamText` call and exposes it as
 * an `AsyncIterable<AbgSignal>`, the universal ABG node contract.
 *
 * KEYSTONE CONSTRAINT (plan §5.2), made STRUCTURAL: every call hardcodes
 * `stopWhen: stepCountIs(1)`, so the SDK performs exactly ONE model call + ONE tool batch
 * per node execution. There is no override: the Observe→Decide→Act loop is owned by the
 * ABG graph (the coordinator's re-entry / driver loop in Phase 1), NOT by the SDK. With
 * the SDK's default multi-step loop, the SDK — not the graph — would be the decision
 * authority, hollowing out D1 and violating ABG §10.3. (In AI SDK v6, `maxSteps` was
 * removed; `stopWhen: stepCountIs(n)` is the equivalent. Whitelisted subagent loops are
 * a Phase 1 concern, reintroduced deliberately and tested.)
 *
 * Signals emitted:
 *   started, llm.turn.started (emit), … per-part deltas/proposals …,
 *   then EITHER llm.turn.completed (emit) + success   (on a completed turn)
 *   OR      llm.error (emit) + failure                  (on stream error / abort).
 * The node always reaches a terminal signal — it never hangs or rejects unhandled.
 */

import type { AbgSignal } from '@mission-control/protocol';
import type { ModelMessage, ToolSet } from 'ai';
import { stepCountIs, streamText } from 'ai';
import { errorToString } from '../../../util/error-to-string.js';
import { createAbgEmitSignal } from '../../abg-emit.js';
import type { AbgToolSettlementLedger } from './abg-tool-bridge.js';
import { abgSignalsFromStreamPart } from './ai-sdk-adapter.js';

type StreamTextParameters = Parameters<typeof streamText>[0];

/** The Vercel AI SDK model type accepted by `streamText({ model })`. */
export type LlmActorModel = StreamTextParameters['model'];

/**
 * The result of one `LLMActor` turn (one model call + one tool batch, per
 * `stopWhen: stepCountIs(1)`). `responseMessages` is the assistant turn INCLUDING any
 * tool-result message (the SDK includes executed tool results in `response.messages`),
 * so the graph can append it to the Blackboard and re-enter with the full history —
 * the loop the SDK's own multi-step machinery would otherwise own.
 */
export type LlmActorTurnResult = {
    readonly text: string;
    readonly usage: unknown;
    readonly responseMessages: readonly ModelMessage[];
};

export type LlmActorRunInput = {
    readonly graphId?: string;
    readonly nodeId: string;
    readonly model: LlmActorModel;
    readonly system: string;
    readonly messages: NonNullable<StreamTextParameters['messages']>;
    readonly tools?: ToolSet;
    readonly signal?: AbortSignal;
    readonly now: () => string;
    readonly settlementLedger?: AbgToolSettlementLedger;
};

export async function* runLlmActor(input: LlmActorRunInput): AsyncIterable<AbgSignal> {
    const { nodeId, now } = input;
    const adapterContext = {
        graphId: input.graphId,
        nodeId,
        now,
        ...(input.settlementLedger !== undefined ? { settlementLedger: input.settlementLedger } : {}),
    };
    const graphIdPart = input.graphId !== undefined ? { graphId: input.graphId } : {};

    yield { type: 'started', nodeId, ...graphIdPart };
    yield createAbgEmitSignal({
        graphId: input.graphId,
        nodeId,
        source: 'llm-actor',
        eventType: 'llm.turn.started',
        timestamp: now(),
    });

    const result = streamText({
        model: input.model,
        system: input.system,
        messages: input.messages,
        stopWhen: stepCountIs(1),
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
        ...(input.signal !== undefined ? { abortSignal: input.signal } : {}),
    });

    let turnText = '';
    let turnUsage: unknown;
    let turnResponseMessages: readonly ModelMessage[] = [];
    try {
        for await (const part of result.fullStream) {
            for (const signal of abgSignalsFromStreamPart(part, adapterContext)) {
                yield signal;
            }
        }
        const [text, usage, response] = await Promise.all([result.text, result.usage, result.response]);
        turnText = text;
        turnUsage = usage;
        turnResponseMessages = response.messages;
    } catch (error) {
        const message = errorToString(error);
        yield createAbgEmitSignal({
            graphId: input.graphId,
            nodeId,
            source: 'llm-actor',
            eventType: 'llm.error',
            timestamp: now(),
            payload: { error: message },
        });
        yield { type: 'failure', nodeId, ...graphIdPart, error: message };
        return;
    }

    yield createAbgEmitSignal({
        graphId: input.graphId,
        nodeId,
        source: 'llm-actor',
        eventType: 'llm.turn.completed',
        timestamp: now(),
        payload: { text: turnText, usage: turnUsage },
    });
    const turnResult: LlmActorTurnResult = {
        text: turnText,
        usage: turnUsage,
        responseMessages: turnResponseMessages,
    };
    yield { type: 'success', nodeId, ...graphIdPart, result: turnResult };
}
