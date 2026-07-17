import {
    type AskUserQuestionRequest,
    createAgentNodeRunBudgetGrantor,
    createCodingAgentNodeRegistry,
    createGraphTurnRunner,
    extractUsageFromModelCallCompleted,
    type ObservabilityRedactor,
    ProjectTrustStore,
    projectApprovalContinuationMessages,
    type SdkModelResolver,
    SessionRunOwner,
    type ToolInvocationSettlement,
} from '@mission-control/core';
import type { AbgSignal, AgentEvent, AgentEventEnvelope, ToolCall } from '@mission-control/protocol';
import { buildCodingAgentSystemPromptEnv, loadTrustedProjectInstructionResources } from './coding-agent-context';
import { createGraphObservabilityRedactor } from './graph-observability-redactor';
import type { createInteractiveApprovalBroker } from './interactive-approval-broker';
import type { CodingAgentTurnOptions } from './interactive-coding-agent-types';
import {
    interactiveGraphStreamSignal,
    type ProviderRenderState,
    renderInteractiveGraphDurableEvent,
} from './interactive-coding-graph-rendering';
import { type AbgOverlayWiring, wireAbgOverlay } from './interactive-coding-overlay';
import { renderInteractiveToolSettlement, renderProviderEnvelope } from './interactive-coding-provider-rendering';
import { createInteractiveToolRegistry, preflightInteractiveToolCall } from './interactive-coding-tools';
import type { InteractiveGraphSignalObserver } from './interactive-graph-signal-observers';
import {
    closeProductionToolRegistry,
    type ProductionToolRegistry,
    withProductionToolSetup,
} from './production-tool-registry';
import { buildCodingAgentGraphForSelection, resolveGraphSdkModel } from './run-agent-graph-prompt';

type OwnedTurnOptions = Omit<CodingAgentTurnOptions, 'prompt'> & { readonly prompt?: string };

type MutableChildHostCallbacks = {
    readonly requestUserQuestion?: (request: AskUserQuestionRequest) => Promise<string>;
    readonly requestUserQuestions?: (requests: readonly AskUserQuestionRequest[]) => Promise<string[]>;
    readonly emitEvent: (event: AgentEvent) => void;
    readonly output: { readonly write: (text: string) => void };
    onSignal?: (signal: AbgSignal) => void | Promise<void>;
    onDurableEvent?: (event: AgentEvent) => void;
    observabilityRedactor?: ObservabilityRedactor;
};

export type InteractiveRunOwnerSetup = {
    readonly owner: SessionRunOwner;
    readonly tools: ProductionToolRegistry;
    readonly observabilityRedactor: ObservabilityRedactor;
    readonly overlayWiring: AbgOverlayWiring | undefined;
};

export async function createInteractiveRunOwner(
    options: OwnedTurnOptions,
    approvals: ReturnType<typeof createInteractiveApprovalBroker>,
    renderState: ProviderRenderState,
): Promise<InteractiveRunOwnerSetup> {
    const resolveSdkModel = await resolveInteractiveSdkModel(options);
    const childHostCallbacks: MutableChildHostCallbacks = {
        ...(options.requestUserQuestion !== undefined ? { requestUserQuestion: options.requestUserQuestion } : {}),
        ...(options.requestUserQuestions !== undefined ? { requestUserQuestions: options.requestUserQuestions } : {}),
        emitEvent: (event: AgentEvent) => options.emitEvent(event),
        output: { write: (text: string) => options.output.write(text) },
    };
    const systemPromptEnv = await buildCodingAgentSystemPromptEnv({
        workspaceRoot: options.workspaceRoot,
        modelId: options.modelProviderSelection.modelID,
    });
    const projectInstructionResources = await loadTrustedProjectInstructionResources(options.workspaceRoot);
    const toolOptions = {
        workspaceRoot: options.workspaceRoot,
        sessionId: options.sessionId,
        modelProviderSelection: options.modelProviderSelection,
        output: options.output,
        emitEvent: options.emitEvent,
        resolveSdkModel,
        enableTrustedBash: await workspaceHasTrustedBash(options.workspaceRoot),
        childHostCallbacks,
        ...(options.commandExecutor !== undefined ? { commandExecutor: options.commandExecutor } : {}),
        ...(options.lspClient !== undefined ? { lspClient: options.lspClient } : {}),
        ...(options.requestUserQuestion !== undefined ? { requestUserQuestion: options.requestUserQuestion } : {}),
        ...(options.requestUserQuestions !== undefined ? { requestUserQuestions: options.requestUserQuestions } : {}),
        ...(options.authStore !== undefined ? { authStore: options.authStore } : {}),
        ...(options.workflowRegistry !== undefined ? { workflowRegistry: options.workflowRegistry } : {}),
        ...(options.onWorkflowStarted !== undefined ? { onWorkflowStarted: options.onWorkflowStarted } : {}),
        ...(options.profileName !== undefined ? { profileName: options.profileName } : {}),
        ...(options.config !== undefined ? { config: options.config } : {}),
        ...(options.taskRuntimeServices !== undefined ? { services: options.taskRuntimeServices } : {}),
    };
    const tools = await createInteractiveToolRegistry(toolOptions, approvals);
    const { registry: toolRegistry, mcpConnectionManager } = tools;
    let overlayWiring: AbgOverlayWiring | undefined;
    const { observabilityRedactor, graphSpec, runProviderTurn } = await withProductionToolSetup(tools, async () => {
        const redactor = await createGraphObservabilityRedactor({
            mcpConnectionManager,
            ...(options.authStore !== undefined ? { authStore: options.authStore } : {}),
        });
        childHostCallbacks.observabilityRedactor = redactor;
        const spec = options.graph ?? buildCodingAgentGraphForSelection(options.modelProviderSelection);
        const extraObservers: readonly InteractiveGraphSignalObserver[] =
            options.abgOverlayController === undefined ? [] : [(signal) => overlayWiring?.observer(signal)];
        const onSignal = interactiveGraphStreamSignal(
            options.output,
            renderState,
            options.workspaceRoot,
            extraObservers,
        );
        childHostCallbacks.onSignal = (signal) => onSignal(signal);
        const requestNodeRunBudgetExtension =
            resolveSdkModel !== undefined
                ? createAgentNodeRunBudgetGrantor({
                      resolveSdkModel,
                      model: {
                          providerID: options.modelProviderSelection.providerID,
                          modelID: options.modelProviderSelection.modelID,
                      },
                  })
                : undefined;
        const turnRunner = createGraphTurnRunner({
            graph: options.graph ?? buildCodingAgentGraphForSelection(options.modelProviderSelection),
            sessionId: options.sessionId,
            now: () => new Date().toISOString(),
            modelProviderSelection: options.modelProviderSelection,
            registry: createCodingAgentNodeRegistry(),
            resolveSdkModel,
            toolRegistry,
            haltOnFailedToolSettlement: true,
            serializeToolExecution: true,
            onSignal,
            systemPromptEnv,
            observabilityRedactor: redactor,
            ...(projectInstructionResources.length > 0 ? { projectInstructionResources } : {}),
            ...(options.pricingTable !== undefined ? { pricingTable: options.pricingTable } : {}),
            ...(requestNodeRunBudgetExtension !== undefined ? { requestNodeRunBudgetExtension } : {}),
        });
        return { observabilityRedactor: redactor, graphSpec: spec, runProviderTurn: turnRunner };
    });

    const onDurableEventHandler = (event: AgentEvent) => {
        renderInteractiveGraphDurableEvent(options.output, renderState, event);
        if (event.type === 'model.call.completed') {
            const usage = extractUsageFromModelCallCompleted(event);
            if (usage !== undefined) options.onUsage?.(usage.inputTokens);
        }
        options.observeStoredEvent?.(event);
        overlayWiring?.onDurableEvent(event);
    };
    childHostCallbacks.onDurableEvent = (event) => onDurableEventHandler(event);

    let owner: SessionRunOwner;
    try {
        owner = new SessionRunOwner({
            sessionId: options.sessionId,
            store: options.store,
            provider: options.provider,
            modelProviderSelection: options.modelProviderSelection,
            projectContext: { workspaceRoot: options.workspaceRoot },
            readMessages: async () =>
                projectApprovalContinuationMessages(
                    await options.store.getEvents(options.sessionId),
                    options.sessionId,
                ),
            toolRegistry,
            runProviderTurn,
            observabilityRedactor,
            onDurableEvent: onDurableEventHandler,
            onProviderEnvelope: (envelope: AgentEventEnvelope) => {
                renderProviderEnvelope(options.output, renderState, envelope);
                overlayWiring?.onProviderEnvelope?.(envelope);
            },
            onToolCall: (toolCall: ToolCall) => {
                overlayWiring?.onToolCall?.(toolCall);
                return preflightInteractiveToolCall(toolCall, toolOptions, approvals);
            },
            onToolSettlement: (settlement: ToolInvocationSettlement) => {
                renderInteractiveToolSettlement(options.output, settlement);
                overlayWiring?.onToolSettlement?.(settlement);
            },
            ...(options.taskRuntimeServices?.sessionControlHost !== undefined
                ? { sessionControlHost: options.taskRuntimeServices.sessionControlHost }
                : {}),
        });
        overlayWiring =
            options.abgOverlayController === undefined
                ? undefined
                : wireAbgOverlay(options.abgOverlayController, graphSpec);
    } catch (error: unknown) {
        overlayWiring?.dispose();
        await closeProductionToolRegistry(tools);
        throw error;
    }

    return { owner, tools, observabilityRedactor, overlayWiring };
}

async function workspaceHasTrustedBash(workspaceRoot: string): Promise<boolean> {
    const trust = await new ProjectTrustStore().getDecision(workspaceRoot);
    return trust.decision === 'trusted';
}

async function resolveInteractiveSdkModel(options: OwnedTurnOptions): Promise<SdkModelResolver> {
    return resolveGraphSdkModel({
        selection: options.modelProviderSelection,
        ...(options.resolveSdkModel !== undefined ? { resolveSdkModel: options.resolveSdkModel } : {}),
        provider: options.provider,
    });
}
