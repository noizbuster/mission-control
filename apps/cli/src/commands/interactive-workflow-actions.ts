import type { AgentRuntime } from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection, WorkflowSpec } from '@mission-control/protocol';
import type { WorkflowInvocationAction } from './chat-commands';
import type { CodingActionContext } from './interactive-chat-action-context';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result';
import type { ChatOutput } from './interactive-chat-io';
import { runPromptAction } from './interactive-prompt-actions';
import { createWorkflowRunOutcomeObserver, redactWorkflowError } from './interactive-workflow-run-outcome';
import { seedOverlayForWorkflow, settleWorkflowRun, tryCreateWorkflowRun } from './interactive-workflow-state';
import { graphForWorkflowSpec, modePoliciesForWorkflowSpec } from './workflow-materialization';

export async function runWorkflowAction(
    runtime: AgentRuntime,
    chatOutput: ChatOutput,
    action: WorkflowInvocationAction,
    selection: ModelProviderSelection,
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    const registry = coding.workflowRegistry;
    if (registry === undefined) {
        chatOutput.write('Workflow invocation unavailable: no workflow registry configured.\n');
        return actionResult(selection, coding.activeTurn);
    }
    const spec = registry.lookup(action.name);
    if (spec === undefined) {
        const names = registry.names();
        chatOutput.write(
            `Unknown workflow: ${action.name}. Available workflows: ${names.length === 0 ? '(none discovered)' : names.slice(0, 20).join(', ')}.\n`,
        );
        return actionResult(selection, coding.activeTurn);
    }
    return runResolvedWorkflowTurn(runtime, chatOutput, spec, action.prompt, selection, coding);
}

export async function startWorkflowTurn(
    runtime: AgentRuntime,
    chatOutput: ChatOutput,
    spec: WorkflowSpec,
    prompt: string,
    selection: ModelProviderSelection,
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    return runResolvedWorkflowTurn(runtime, chatOutput, spec, prompt, selection, { ...coding, activeTurn: undefined });
}

async function runResolvedWorkflowTurn(
    runtime: AgentRuntime,
    chatOutput: ChatOutput,
    spec: WorkflowSpec,
    prompt: string,
    selection: ModelProviderSelection,
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    chatOutput.write(`Running workflow "${spec.name}"...\n`);
    chatOutput.showNotice?.(`Workflow: ${spec.name}`);
    const workflowGraph = graphForWorkflowSpec(spec);
    const workflowModePolicies = modePoliciesForWorkflowSpec(spec);
    seedOverlayForWorkflow(coding, workflowGraph);
    let runHandle: Awaited<ReturnType<typeof tryCreateWorkflowRun>>;
    try {
        runHandle =
            coding.activeTurn === undefined
                ? await tryCreateWorkflowRun(
                      coding.workspaceRoot,
                      spec,
                      workflowGraph,
                      prompt,
                      coding.sessionId,
                      coding.taskRuntimeServices?.sessionControlHost,
                      coding.observabilityRedactor,
                  )
                : undefined;
    } catch (error: unknown) {
        throw redactWorkflowError(error instanceof Error ? error : new Error(String(error)));
    }
    if (runHandle === undefined)
        return runPromptAction(runtime, chatOutput, prompt, selection, {
            ...coding,
            graph: workflowGraph,
            ...(workflowModePolicies !== undefined ? { modePolicies: workflowModePolicies } : {}),
        });
    const turnId = coding.nextTurnId();
    const observer = createWorkflowRunOutcomeObserver({
        ...(coding.sessionId !== undefined ? { expectedSessionId: coding.sessionId } : {}),
        expectedTaskId: turnId,
        requireOwnerRunIdentity: coding.sessionStore !== undefined,
        settleOutcome: (outcome, sessionRunId) => settleWorkflowRun(runHandle, outcome, coding.sessionId, sessionRunId),
    });
    let result: ChatActionResult;
    try {
        result = await runPromptAction(runtime, chatOutput, prompt, selection, {
            ...coding,
            graph: workflowGraph,
            ...(workflowModePolicies !== undefined ? { modePolicies: workflowModePolicies } : {}),
            nextTurnId: () => turnId,
            emitEvent: (event: AgentEvent) => {
                observer.observe(event);
                coding.emitEvent?.(event);
            },
            observeStoredEvent: (event: AgentEvent) => {
                observer.observe(event);
                coding.observeStoredEvent?.(event);
            },
        });
    } catch (error: unknown) {
        await observer.settle({ status: 'failed', reason: 'workflow turn setup failed' });
        throw redactWorkflowError(error instanceof Error ? error : new Error(String(error)));
    }
    if (result.activeTurn === undefined) {
        await observer.settle({ status: 'failed', reason: 'workflow turn failed' });
        return result;
    }
    const activeTurn = result.activeTurn;
    return {
        ...result,
        activeTurn: {
            ...activeTurn,
            done: activeTurn.done.then(() =>
                observer.settle({ status: 'failed', reason: 'workflow turn settled without a terminal event' }),
            ),
        },
    };
}
