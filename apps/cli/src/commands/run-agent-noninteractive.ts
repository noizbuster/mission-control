import {
    createAgentNodeRunBudgetGrantor,
    createCodingAgentNodeRegistry,
    createGraphTurnRunner,
    PermissionGateError,
    redactAgentEventForObservability,
} from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { buildCodingAgentSystemPromptEnv, loadTrustedProjectInstructionResources } from './coding-agent-context';
import { redactWorkflowError } from './interactive-workflow-run-outcome';
import type { MissionControlServices } from './mission-control-services';
import { resolveMissionControlServices } from './mission-control-services-resolver';
import { loadPricingTable } from './pricing-table-store';
import {
    buildCodingAgentGraphForSelection,
    resolveGraphSdkModel,
    runCodingPromptOnGraph,
} from './run-agent-graph-prompt';
import type { RunNoninteractiveAgentInput } from './run-agent-noninteractive-types';
import { runOwnerPrompt } from './run-agent-owner-prompt';
import { closePersistentStore, createRenderer } from './run-agent-rendering';
import { createRunEventRecorder } from './run-agent-session';
import { resolveNoninteractiveWorkflowSelection } from './run-agent-workflow';
import {
    beginNoninteractiveWorkflowRun,
    settleNoninteractiveWorkflowRun,
    settleNoninteractiveWorkflowRunWithOwner,
    type WorkflowRunOutcome,
    workflowOutcomeFromGraphStatus,
    workflowOutcomeFromOwnerStatus,
} from './run-agent-workflow-run';

export async function runNoninteractiveAgent(input: RunNoninteractiveAgentInput): Promise<string> {
    const { args, options, runtime, authStore, provider, selectedModelProvider, workspaceRoot, graph } = input;
    const recorder = await createRunEventRecorder(args, {
        workspaceRoot,
        observabilityRedactor: input.observabilityRedactor,
    });
    const renderer = createRenderer(args.mode, args.thinking);
    const unsubscribe = runtime.onEvent((event) => renderer.render(recorder.record(event)));
    const emitRuntimeEvent = (event: AgentEvent) => renderer.render(recorder.record(event));
    const observeStoredEvent = (event: AgentEvent) => {
        renderer.render(redactAgentEventForObservability(event, input.observabilityRedactor));
    };
    let didStart = false;
    let ownerSettlementAttempted = false;
    const pricingTable = await loadPricingTable();
    const { effectivePrompt, workflowGraph, workflowSpec } = await resolveNoninteractiveWorkflowSelection({
        args,
        workspaceRoot,
        graph,
    });
    const promptGraph =
        options.plainPromptGraph === 'coding-agent' && workflowSpec === undefined ? undefined : workflowGraph;
    const workflowRunSessionId = recorder.currentSessionId();
    const usesOwnerPrompt =
        graph === undefined &&
        effectivePrompt !== undefined &&
        workflowRunSessionId !== undefined &&
        recorder.currentStore() !== undefined;
    let missionControlServices: MissionControlServices | undefined;
    let workflowRun: Awaited<ReturnType<typeof beginNoninteractiveWorkflowRun>>;
    try {
        missionControlServices = usesOwnerPrompt
            ? await resolveMissionControlServices(workspaceRoot, {
                  observabilityRedactor: input.observabilityRedactor,
              })
            : undefined;
        try {
            workflowRun = await beginNoninteractiveWorkflowRun(workspaceRoot, workflowSpec, {
                ...(workflowRunSessionId !== undefined ? { sessionId: workflowRunSessionId } : {}),
                ...(workflowSpec !== undefined ? { graph: workflowGraph } : {}),
                ...(effectivePrompt !== undefined ? { prompt: effectivePrompt } : {}),
                ...(missionControlServices !== undefined
                    ? { sessionControlHost: missionControlServices.getSessionControlHost() }
                    : {}),
                observabilityRedactor: input.observabilityRedactor,
            });
        } catch (error: unknown) {
            throw redactWorkflowError(error instanceof Error ? error : new Error(String(error)));
        }
        try {
            await renderer.start(runtime);
            await runtime.start();
        } catch (error: unknown) {
            await settleNoninteractiveWorkflowRun(workflowRun, {
                status: 'failed',
                reason: 'workflow runtime setup failed',
            });
            const surfacedError = error instanceof Error ? error : new Error(String(error));
            throw redactWorkflowError(surfacedError);
        }
        didStart = true;
        let workflowOutcome: WorkflowRunOutcome | undefined;
        try {
            if (graph !== undefined) {
                await runtime.runGraph(graph, undefined, { observabilityRedactor: input.observabilityRedactor });
            } else if (
                effectivePrompt !== undefined &&
                recorder.currentStore() !== undefined &&
                recorder.currentSessionId() !== undefined
            ) {
                const sessionStore = recorder.currentStore();
                const sessionId = recorder.currentSessionId();
                if (sessionStore === undefined || sessionId === undefined) {
                    throw new TypeError('durable session recorder became unavailable while running a prompt');
                }
                const resolveSdkModel = await resolveGraphSdkModel({
                    selection: selectedModelProvider,
                    ...(options.resolveSdkModel !== undefined ? { resolveSdkModel: options.resolveSdkModel } : {}),
                    authStore,
                    ...(options.provider !== undefined ? { provider: options.provider } : {}),
                });
                const systemPromptEnv = await buildCodingAgentSystemPromptEnv({
                    workspaceRoot,
                    modelId: selectedModelProvider.modelID,
                });
                const projectInstructionResources = await loadTrustedProjectInstructionResources(workspaceRoot);
                const ownerResult = await runOwnerPrompt({
                    sessionId,
                    store: sessionStore,
                    provider,
                    modelProviderSelection: selectedModelProvider,
                    workspaceRoot,
                    config: input.config,
                    prompt: effectivePrompt,
                    emitEvent: emitRuntimeEvent,
                    observeStoredEvent,
                    resolveSdkModel,
                    createTurnRunner: ({ toolRegistry, observabilityRedactor }) =>
                        createGraphTurnRunner({
                            graph: promptGraph ?? buildCodingAgentGraphForSelection(selectedModelProvider),
                            sessionId,
                            now: () => new Date().toISOString(),
                            modelProviderSelection: selectedModelProvider,
                            registry: createCodingAgentNodeRegistry(),
                            resolveSdkModel,
                            toolRegistry,
                            haltOnFailedToolSettlement: true,
                            systemPromptEnv,
                            observabilityRedactor,
                            ...(projectInstructionResources.length > 0 ? { projectInstructionResources } : {}),
                            ...(pricingTable.length > 0 ? { pricingTable } : {}),
                            requestNodeRunBudgetExtension: createAgentNodeRunBudgetGrantor({
                                resolveSdkModel,
                                model: {
                                    providerID: selectedModelProvider.providerID,
                                    modelID: selectedModelProvider.modelID,
                                },
                            }),
                        }),
                    ...(options.commandExecutor !== undefined ? { commandExecutor: options.commandExecutor } : {}),
                    authStore,
                    ...(args.profileName !== undefined ? { profileName: args.profileName } : {}),
                    ...(options.nonInteractiveAutomationPolicy !== undefined
                        ? { nonInteractiveAutomationPolicy: options.nonInteractiveAutomationPolicy }
                        : {}),
                    ...(missionControlServices !== undefined
                        ? { taskRuntimeServices: missionControlServices.getTaskRuntimeServices() }
                        : {}),
                });
                const ownerOutcome = workflowOutcomeFromOwnerStatus(ownerResult.status);
                if (ownerResult.runId === undefined) {
                    workflowOutcome = ownerOutcome;
                } else {
                    ownerSettlementAttempted = true;
                    await settleNoninteractiveWorkflowRunWithOwner(workflowRun, ownerOutcome, {
                        sessionId,
                        sessionRunId: ownerResult.runId,
                    });
                    workflowOutcome = undefined;
                }
                if (ownerResult.status === 'failed' && args.mode === 'plain') {
                    throw new Error(ownerResult.reason ?? 'workflow turn failed');
                }
            } else if (effectivePrompt !== undefined) {
                const graphResult = await runCodingPromptOnGraph({
                    runtime,
                    selection: selectedModelProvider,
                    prompt: effectivePrompt,
                    workspaceRoot,
                    config: input.config,
                    ...(promptGraph !== undefined ? { graph: promptGraph } : {}),
                    ...(options.resolveSdkModel !== undefined ? { resolveSdkModel: options.resolveSdkModel } : {}),
                    authStore,
                    ...(options.provider !== undefined ? { provider: options.provider } : {}),
                    ...(options.commandExecutor !== undefined ? { commandExecutor: options.commandExecutor } : {}),
                    ...(pricingTable.length > 0 ? { pricingTable } : {}),
                    ...(input.agentModelLookup !== undefined ? { agentModelLookup: input.agentModelLookup } : {}),
                    ...(args.profileName !== undefined ? { profileName: args.profileName } : {}),
                });
                workflowOutcome = workflowOutcomeFromGraphStatus(graphResult.status, graphResult.reason);
            } else {
                await runtime.runDemoTask();
            }
        } catch (error: unknown) {
            if (!(error instanceof PermissionGateError)) {
                if (!ownerSettlementAttempted) {
                    await settleNoninteractiveWorkflowRun(workflowRun, {
                        status: 'failed',
                        reason: error instanceof Error ? error.message : String(error),
                    });
                }
                throw redactWorkflowError(error);
            }
            await settleNoninteractiveWorkflowRun(workflowRun, {
                status: 'blocked',
                reason: error instanceof Error ? error.message : 'approval required',
            });
            workflowOutcome = undefined;
        }
        if (workflowOutcome !== undefined) {
            await settleNoninteractiveWorkflowRun(workflowRun, workflowOutcome);
        }
        await runtime.stop();
        didStart = false;
    } finally {
        try {
            if (didStart) {
                await runtime.stop();
            }
        } finally {
            try {
                unsubscribe();
                try {
                    await recorder.close();
                } finally {
                    await renderer.stop();
                }
            } finally {
                try {
                    await missionControlServices?.dispose();
                } finally {
                    closePersistentStore(input.persistentStore);
                }
            }
        }
    }
    return renderer.streamedOutput === true ? '' : renderer.getOutput();
}
