/**
 * LLMActor as an ABG node runner (`AbgNodeRunner`).
 *
 * This is the bridge between the graph and the Phase-0 Vercel-AI-SDK keystone. The node:
 *   1. reads the running conversation from the Blackboard (`getMessages`);
 *   2. builds the AI-SDK tool set from the ToolRegistry via `abg-tool-bridge` (so every
 *      tool crosses the §5.2 policy-await seam — the SDK owns dispatch, ABG wraps it);
 *   3. runs exactly ONE `streamText` step — `runLlmActor` pins `stopWhen: stepCountIs(1)`,
 *      so each node run = one model call + one tool batch (the SDK never loops on its own);
 *   4. appends the SDK's response messages (assistant turn + executed tool results) back
 *      onto the Blackboard, and sets `llm.loop_active`.
 *
 * The graph re-enters this node for the next step via a rule-gated self-edge on
 * `blackboard.value.equals { key:'llm.loop_active', value:true }`. So the GRAPH owns the
 * loop — every tool turn is a graph transition — never the SDK (ABG §10.3).
 *
 * Resolves the "runLlmActor not yet AbgNodeRunner-shaped" part of deferred review #10:
 * the LLMActor is now graph-driven with an observable signal stream; the authoritative
 * 3-state per-action policy decision lives at node altitude in `PolicyGateNode`,
 * complementing the bridge's synchronous SDK-contract gate.
 */
import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import type { ConversationSummary } from '../../../context/compaction.js';
import { packContext } from '../../../context/context-packer.js';
import { assembleSystemPrompt } from '../../../context/system-prompt.js';
import type { Blackboard } from '../../../memory/blackboard.js';
import { createAbgEmitSignal } from '../../abg-emit.js';
import type { AbgNodeRunContext, AbgNodeRunner } from '../../node-registry.js';
import { bridgeAdvertisementsToAiSdk, createAbgToolSettlementLedger } from './abg-tool-bridge.js';
import { type LlmActorTurnResult, runLlmActor } from './llm-actor-node.js';

export async function* runLlmActorNode(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
    const nodeId = node.id;
    const graphIdPart = { graphId: context.graphId };

    if (context.sdkModel === undefined) {
        yield { type: 'started', nodeId, ...graphIdPart };
        yield {
            type: 'failure',
            nodeId,
            ...graphIdPart,
            error: { code: 'llm_model_unavailable', message: 'no SDK model resolved for the LLMActor node' },
        };
        return;
    }
    const blackboard = context.blackboard;
    if (blackboard === undefined) {
        yield { type: 'started', nodeId, ...graphIdPart };
        yield {
            type: 'failure',
            nodeId,
            ...graphIdPart,
            error: { code: 'memory_unavailable', message: 'LLMActor requires a blackboard for the conversation' },
        };
        return;
    }
    const messages = blackboard.getMessages();
    if (messages.length === 0) {
        yield { type: 'started', nodeId, ...graphIdPart };
        yield {
            type: 'failure',
            nodeId,
            ...graphIdPart,
            error: { code: 'llm_no_input', message: 'the blackboard has no messages to send to the model' },
        };
        return;
    }

    const toolSnippets =
        context.toolRegistry !== undefined
            ? context.toolRegistry.advertise().map((advertisement) => ({
                  name: advertisement.name,
                  description: advertisement.description,
              }))
            : [];
    const system = readStringConfig(node, 'systemPrompt') ?? assembleSystemPrompt({ toolSnippets });
    // One ledger per turn: the bridge records each tool settlement; the stream-part adapter
    // reads it so the `tool.completed`/`tool.failed` emits carry the true status/output/error
    // (coding-step replay parity with the flat path). Fresh per turn — no stale entries leak.
    const settlementLedger = createAbgToolSettlementLedger();
    const tools =
        context.toolRegistry !== undefined
            ? bridgeAdvertisementsToAiSdk(context.toolRegistry, context.toolRegistry.advertise(), {
                  settlementLedger,
                  // Forward the tool's own events (file.diff.applied, ...) into the graph stream so
                  // the graph surfaces the same rich tool events the flat loop's settleToolCalls does.
                  ...(context.emitEvent !== undefined ? { onToolEvent: context.emitEvent } : {}),
                  // Interactive path: serialize a tool BATCH so the approval broker sees one approval
                  // at a time (non-interactive omits this → parallel batch execution).
                  ...(context.serializeToolExecution === true ? { serializeToolExecution: true } : {}),
              })
            : undefined;

    // Keep the model's input BOUNDED across a long run: compact the older conversation into a
    // structured summary when it exceeds the budget, preserving the recent tail verbatim. The
    // full history stays on the Blackboard (the ledger); only the model-facing view is packed.
    const priorSummary = readPriorSummary(blackboard);
    const packed = packContext({
        messages,
        ...(priorSummary !== undefined ? { priorSummary } : {}),
    });
    if (packed.compacted && packed.summary !== undefined) {
        blackboard.set('context.summary', packed.summary);
        yield createAbgEmitSignal({
            graphId: context.graphId,
            nodeId,
            source: 'llm-actor',
            eventType: 'context.packed',
            timestamp: context.now(),
            payload: {
                estimatedTokens: packed.estimatedTokens,
                cutPointIndex: packed.cutPointIndex,
                summarizedMessageCount: packed.summary.summarizedMessageCount,
            },
        });
    }

    let turnResult: LlmActorTurnResult | undefined;
    let proposedToolCalls = 0;
    for await (const signal of runLlmActor({
        graphId: context.graphId,
        nodeId,
        model: context.sdkModel,
        system,
        messages: [...packed.messages],
        ...(tools !== undefined ? { tools } : {}),
        ...(context.abortSignal !== undefined ? { signal: context.abortSignal } : {}),
        now: context.now,
        ...(context.toolRegistry !== undefined ? { settlementLedger } : {}),
        ...(context.haltOnFailedToolSettlement === true ? { haltOnFailedToolSettlement: true } : {}),
    })) {
        if (signal.type === 'emit' && signal.event.type === 'llm.tool_call.proposed') {
            proposedToolCalls += 1;
        }
        if (signal.type === 'success') {
            turnResult = extractTurnResult(signal.result);
        }
        yield signal;
    }

    // loop_active is ALWAYS written so a failed/aborted turn after a tool step CLEARS it
    // (otherwise the rule-gated self-edge would spin re-entering until maxNodeRuns). It is
    // derived from THIS turn's tool-call proposals — what the model decided this step — not
    // from response.messages roles, so it is robust to how the SDK shapes response.messages.
    const loopActive = turnResult !== undefined && proposedToolCalls > 0;
    blackboard.set('llm.loop_active', loopActive);
    if (turnResult !== undefined) {
        // The SDK's response.messages already contains the assistant turn AND every executed
        // tool-result message (per the AI-SDK contract), so appending it grows the
        // conversation for the next graph-driven step.
        blackboard.appendMessages(turnResult.responseMessages);
        // Price this turn's usage and surface `policy.budget.*` events when a ledger is wired
        // (ABG §11.4). The graph can route `policy.budget.exceeded` to an escalate/abort node.
        if (context.budgetLedger !== undefined && context.model !== undefined) {
            for (const event of context.budgetLedger.accumulate({
                usage: turnResult.usage,
                selection: context.model,
            })) {
                const { eventType, cents, inputTokens, outputTokens, modelCalls, ...rest } = event;
                yield createAbgEmitSignal({
                    graphId: context.graphId,
                    nodeId,
                    source: 'llm-actor',
                    eventType,
                    timestamp: context.now(),
                    payload: {
                        cents,
                        inputTokens,
                        outputTokens,
                        modelCalls,
                        ...rest,
                    },
                });
            }
        }
    }
}

function readStringConfig(node: AbgNodeSpec, key: string): string | undefined {
    const value = node.config?.[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Read the prior compaction summary from the Blackboard (written on a previous context.packed). */
function readPriorSummary(blackboard: Blackboard): ConversationSummary | undefined {
    const value = blackboard.get('context.summary');
    if (value === undefined || value === null || typeof value !== 'object') {
        return undefined;
    }
    if (!('goal' in value) || !('summarizedMessageCount' in value)) {
        return undefined;
    }
    return value as ConversationSummary;
}

function extractTurnResult(result: unknown): LlmActorTurnResult | undefined {
    if (result === null || typeof result !== 'object' || !('responseMessages' in result)) {
        return undefined;
    }
    const candidate = result as { text?: unknown; usage?: unknown; responseMessages?: unknown };
    const responseMessages = candidate.responseMessages;
    if (!Array.isArray(responseMessages)) {
        return undefined;
    }
    return {
        text: typeof candidate.text === 'string' ? candidate.text : '',
        usage: candidate.usage,
        responseMessages: responseMessages as readonly ModelMessage[],
    };
}

export type { AbgNodeRunner };
