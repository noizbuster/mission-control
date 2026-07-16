// allow: SIZE_OK -- single LLMActor turn state machine: tool bridge + pure generate_object
// gates + hybrid free-text outputKey + budget ledger must stay in one generator.
/**
 * LLMActor as an ABG node runner: one streamText step, tool bridge, structured output
 * (OpenCode forced generate_object on pure gates), blackboard loop_active ownership.
 */
import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import { packContext } from '../../../context/context-packer';
import { assembleSystemPrompt, type SystemPromptSkill } from '../../../context/system-prompt';
import { createAbgEmitSignal } from '../../abg-emit';
import type { AbgNodeRunContext, AbgNodeRunner } from '../../node-registry';
import type { ToolSet } from 'ai';
import { bridgeAdvertisementsToAiSdk, createAbgToolSettlementLedger } from './abg-tool-bridge';
import { type LlmActorTurnResult, runLlmActor } from './llm-actor-node';
import {
    applyEnumConstraint,
    filterByCapabilities,
    readPriorSummary,
    readStringConfig,
} from './llm-actor-node-helpers';
import { extractProposedToolName } from './llm-actor-settlements';
import { discoverPromptSkills } from './llm-actor-skill-cache';
import {
    appendStructuredOutputSystem,
    createPureStructuredGateTools,
    type GenerateObjectCapture,
    isGenerateObjectToolName,
    resolveStructuredOutputFromTurn,
} from './structured-output-tool';

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

    const hasOutputKey = readStringConfig(node, 'outputKey') !== undefined;
    const hasCapabilities = (node.capabilities ?? []).length > 0;
    const capabilitiesExplicitlyEmpty = Array.isArray(node.capabilities) && node.capabilities.length === 0;
    const suppressTools = capabilitiesExplicitlyEmpty || (hasOutputKey && !hasCapabilities);
    const allAdvertisements = suppressTools
        ? []
        : context.toolRegistry !== undefined
          ? context.toolRegistry.advertise()
          : [];
    const advertisements = filterByCapabilities(allAdvertisements, node.capabilities);
    const toolSnippets = advertisements.map((advertisement) => ({
        name: advertisement.name,
        description: advertisement.description,
    }));
    const guidelines = advertisements
        .map((advertisement) => advertisement.guideline)
        .filter((guideline): guideline is string => typeof guideline === 'string' && guideline.length > 0);
    // Discover skills once per graph run (cached on the per-run Blackboard), invalidated by a
    // recursive per-file mtime+size manifest so newly added or edited SKILL.md files are picked
    // up without a restart. Only name + description + location go into the prompt (NOT bodies —
    // bodies load on demand via the `skill` tool). Skills with disableModelInvocation are hidden.
    const workspaceRoot = context.systemPromptEnv?.workspaceRoot;
    const skills: readonly SystemPromptSkill[] =
        workspaceRoot !== undefined ? await discoverPromptSkills(workspaceRoot, blackboard) : [];
    // The system prompt is assembled with the caller-supplied environment + trusted project
    // instructions. Without `env` the model has no workspace awareness (cwd, git, date); without
    // `resources` it never sees AGENTS.md/CLAUDE.md — both gaps make the agent answer generically
    // instead of acting on the codebase. An explicit node `systemPrompt` config still wins.
    const baseSystem =
        readStringConfig(node, 'systemPrompt') ??
        assembleSystemPrompt({
            toolSnippets,
            guidelines,
            skills,
            ...(context.systemPromptEnv !== undefined ? { env: context.systemPromptEnv } : {}),
            ...(context.projectInstructionResources !== undefined
                ? { resources: context.projectInstructionResources }
                : {}),
        });
    const correctedSystem =
        context.retryCorrection !== undefined && context.retryCorrection.length > 0
            ? `${context.retryCorrection}\n\n${baseSystem}`
            : baseSystem;
    const outputKeyConfig = readStringConfig(node, 'outputKey');
    const pureStructuredGate = outputKeyConfig !== undefined && suppressTools;
    const system = appendStructuredOutputSystem(correctedSystem, node, {
        pureStructuredGate,
        outputKey: outputKeyConfig,
    });
    const settlementLedger = createAbgToolSettlementLedger();
    let generateObjectCapture: GenerateObjectCapture | undefined;
    const workspaceTools: ToolSet | undefined =
        suppressTools || context.toolRegistry === undefined
            ? undefined
            : bridgeAdvertisementsToAiSdk(context.toolRegistry, advertisements, {
                  settlementLedger,
                  ...(context.emitEvent !== undefined ? { onToolEvent: context.emitEvent } : {}),
                  ...(context.serializeToolExecution === true ? { serializeToolExecution: true } : {}),
                  ...(context.controlEpoch !== undefined ? { controlEpoch: context.controlEpoch } : {}),
              });
    const pureGateTools = pureStructuredGate
        ? createPureStructuredGateTools(node, (capture) => {
              generateObjectCapture = capture;
          })
        : undefined;
    const tools: ToolSet | undefined = pureGateTools?.tools ?? workspaceTools;
    const toolChoice = pureGateTools?.toolChoice;
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

    const modelMessages = [...packed.messages];

    let turnResult: LlmActorTurnResult | undefined;
    let proposedWorkspaceToolCalls = 0;
    for await (const signal of runLlmActor({
        graphId: context.graphId,
        nodeId,
        model: context.sdkModel,
        system,
        messages: modelMessages,
        ...(tools !== undefined ? { tools } : {}),
        ...(toolChoice !== undefined ? { toolChoice } : {}),
        ...(context.abortSignal !== undefined ? { signal: context.abortSignal } : {}),
        now: context.now,
        ...(context.toolRegistry !== undefined || pureStructuredGate
            ? { settlementLedger }
            : {}),
        ...(context.haltOnFailedToolSettlement === true ? { haltOnFailedToolSettlement: true } : {}),
        ...(context.observabilityRedactor !== undefined
            ? { observabilityRedactor: context.observabilityRedactor }
            : {}),
        captureRawTurnResult: (result) => {
            turnResult = result;
        },
    })) {
        if (signal.type === 'emit' && signal.event.type === 'llm.tool_call.proposed') {
            const toolName = extractProposedToolName(signal.event.payload);
            if (toolName === undefined || !isGenerateObjectToolName(toolName)) {
                proposedWorkspaceToolCalls += 1;
            }
        }
        yield signal;
    }

    // loop_active is ALWAYS written so a failed/aborted turn after a tool step CLEARS it
    // (otherwise the rule-gated self-edge would spin re-entering until maxNodeRuns). It is
    // derived from THIS turn's workspace tool-call proposals — generate_object is not a loop.
    let loopActive = turnResult !== undefined && proposedWorkspaceToolCalls > 0;
    blackboard.set('llm.loop_active', loopActive);
    if (turnResult !== undefined) {
        blackboard.appendMessages(turnResult.responseMessages);
        const outputKey = readStringConfig(node, 'outputKey');
        if (outputKey !== undefined) {
            const outputResult = applyEnumConstraint(
                node,
                resolveStructuredOutputFromTurn({
                    node,
                    pureStructuredGate,
                    generateObjectCapture,
                    turnText: turnResult.text,
                }),
            );
            if (outputResult.ok) {
                blackboard.set(outputKey, outputResult.value);
                yield createAbgEmitSignal({
                    graphId: context.graphId,
                    nodeId,
                    source: 'llm-actor',
                    eventType: 'blackboard.set',
                    timestamp: context.now(),
                    payload: { key: outputKey, value: outputResult.value },
                });
                // If the model produced valid structured output ALONGSIDE tool calls, clear
                // loopActive so the graph advances past this node instead of spinning on the
                // self-edge. Previously the outputKey was only persisted when loopActive was
                // already false, so a model that called tools AND emitted its classification
                // in one turn would loop forever (bounded only by maxNodeRuns).
                if (loopActive) {
                    loopActive = false;
                    blackboard.set('llm.loop_active', false);
                }
            } else if (!loopActive) {
                // FAIL CLOSED: invalid structured output for a declared outputKey on a turn
                // that did NOT request another tool loop. Do not persist a partial/garbage
                // value; surface a node failure so the graph can route to a fallback.
                // When loopActive is true, leave the loop running so the model gets another
                // chance to produce valid output on the next re-entry (the loop-active cap
                // from the coordinator still bounds the total number of retries).
                yield {
                    type: 'failure',
                    nodeId,
                    ...graphIdPart,
                    error: {
                        code: 'invalid_structured_output',
                        message: `invalid structured output for outputKey ${outputKey}: ${outputResult.error}`,
                    },
                };
                return;
            }
        }
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

export type { AbgNodeRunner };
