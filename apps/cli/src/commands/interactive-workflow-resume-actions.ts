import {
    type AgentRuntime,
    findMostRecentFailedRun,
    findResumableBlockedRun,
    normalizeMissionRunStoreLocation,
    readMission,
    resolveOmoRoot,
    updateRunStatus,
} from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import type { CodingActionContext } from './interactive-chat-action-context';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result';
import type { ChatOutput } from './interactive-chat-io';
import { type ActiveCodingAgentTurn, resumeCodingAgentTurn } from './interactive-coding-agent';
import { runWorkflowAction } from './interactive-workflow-actions';
import { createWorkflowRunOutcomeObserver, redactWorkflowError } from './interactive-workflow-run-outcome';
import { findResumableWorkflowRun, settleWorkflowRun } from './interactive-workflow-state';

export async function runInterruptAction(
    chatOutput: ChatOutput,
    selection: ModelProviderSelection,
    activeTurn: ActiveCodingAgentTurn | undefined,
): Promise<ChatActionResult> {
    if (activeTurn === undefined) {
        chatOutput.write('No active run to interrupt\n');
        return actionResult(selection);
    }
    activeTurn.interrupt('force');
    await activeTurn.done;
    return actionResult(selection);
}

export async function runApprovalResumeAction(
    chatOutput: ChatOutput,
    selection: ModelProviderSelection,
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    if (coding.activeTurn !== undefined) {
        emitResumeRequest(chatOutput, coding, 'running');
        return actionResult(selection, coding.activeTurn);
    }
    if (
        coding.provider === undefined ||
        coding.sessionId === undefined ||
        coding.workspaceRoot === undefined ||
        coding.sessionStore === undefined
    ) {
        chatOutput.write('Nothing to resume — no provider/session configured. Send a prompt to start a run.\n');
        return actionResult(selection);
    }
    chatOutput.write(`Resuming run for ${coding.sessionId}\n`);
    const blockedSessionRun = findResumableBlockedRun(await coding.sessionStore.getEvents(coding.sessionId));
    const resumableWorkflow =
        blockedSessionRun === undefined
            ? undefined
            : await findResumableWorkflowRun({
                  workspaceRoot: coding.workspaceRoot,
                  sessionId: coding.sessionId,
                  sessionRunId: blockedSessionRun.runId,
                  ...(coding.workflowRegistry !== undefined ? { workflowRegistry: coding.workflowRegistry } : {}),
                  ...(coding.observabilityRedactor !== undefined
                      ? { observabilityRedactor: coding.observabilityRedactor }
                      : {}),
              });
    const turnId = coding.nextTurnId();
    const observer =
        resumableWorkflow === undefined
            ? undefined
            : createWorkflowRunOutcomeObserver({
                  expectedSessionId: coding.sessionId,
                  expectedTaskId: turnId,
                  requireOwnerRunIdentity: true,
                  settleOutcome: (outcome, sessionRunId) =>
                      settleWorkflowRun(resumableWorkflow.handle, outcome, coding.sessionId, sessionRunId),
              });
    if (resumableWorkflow !== undefined) {
        await updateRunStatus(resumableWorkflow.handle.location, resumableWorkflow.handle.runId, 'running');
    }
    let activeTurn: ActiveCodingAgentTurn;
    try {
        activeTurn = await resumeCodingAgentTurn({
            sessionId: coding.sessionId,
            turnId,
            store: coding.sessionStore,
            provider: coding.provider,
            modelProviderSelection: selection,
            workspaceRoot: coding.workspaceRoot,
            output: chatOutput,
            emitEvent: (event) => {
                observer?.observe(event);
                coding.emitEvent?.(event);
            },
            observeStoredEvent: (event) => {
                observer?.observe(event);
                coding.observeStoredEvent?.(event);
            },
            ...(coding.commandExecutor !== undefined ? { commandExecutor: coding.commandExecutor } : {}),
            ...(coding.engine !== undefined ? { engine: coding.engine } : {}),
            ...(coding.resolveSdkModel !== undefined ? { resolveSdkModel: coding.resolveSdkModel } : {}),
            ...(coding.requestUserQuestion !== undefined ? { requestUserQuestion: coding.requestUserQuestion } : {}),
            ...(coding.requestUserQuestions !== undefined ? { requestUserQuestions: coding.requestUserQuestions } : {}),
            ...(coding.abgOverlayController !== undefined ? { abgOverlayController: coding.abgOverlayController } : {}),
            ...(coding.pricingTable !== undefined ? { pricingTable: coding.pricingTable } : {}),
            ...(coding.permissionSession !== undefined ? { permissionSession: coding.permissionSession } : {}),
            ...(coding.onUsage !== undefined ? { onUsage: coding.onUsage } : {}),
            ...(coding.authStore !== undefined ? { authStore: coding.authStore } : {}),
            ...(coding.workflowRegistry !== undefined ? { workflowRegistry: coding.workflowRegistry } : {}),
            ...(coding.profileName !== undefined ? { profileName: coding.profileName } : {}),
            ...(coding.taskRuntimeServices !== undefined ? { taskRuntimeServices: coding.taskRuntimeServices } : {}),
            ...(resumableWorkflow !== undefined ? { graph: resumableWorkflow.graph } : {}),
        });
    } catch (error: unknown) {
        await observer?.settle({ status: 'failed', reason: 'workflow resume setup failed' });
        throw redactWorkflowError(error instanceof Error ? error : new Error(String(error)));
    }
    if (observer === undefined) return actionResult(selection, activeTurn);
    return actionResult(selection, {
        ...activeTurn,
        done: activeTurn.done.then(() =>
            observer.settle({ status: 'failed', reason: 'workflow resume settled without a terminal event' }),
        ),
    });
}

export async function runRetryAction(
    runtime: AgentRuntime,
    chatOutput: ChatOutput,
    selection: ModelProviderSelection,
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    if (coding.activeTurn !== undefined) {
        chatOutput.write('A turn is already running. Interrupt it first (/interrupt or Ctrl+C twice).\n');
        return actionResult(selection, coding.activeTurn);
    }
    if (coding.workspaceRoot === undefined || coding.workflowRegistry === undefined) {
        chatOutput.write('Retry unavailable: no workspace or workflow registry.\n');
        return actionResult(selection);
    }
    let omoRoot: string;
    try {
        omoRoot = await resolveOmoRoot(coding.workspaceRoot);
    } catch {
        chatOutput.write('Retry unavailable: no .omo root for this workspace.\n');
        return actionResult(selection);
    }
    const location = normalizeMissionRunStoreLocation({
        omoRoot,
        ...(coding.observabilityRedactor !== undefined ? { observabilityRedactor: coding.observabilityRedactor } : {}),
    });
    const failed = await findMostRecentFailedRun(location);
    if (failed === undefined) {
        chatOutput.write('No failed run to retry. Type a prompt or use #<workflow> {prompt} to start a new run.\n');
        return actionResult(selection);
    }
    if (failed.prompt === undefined) {
        chatOutput.write(
            `Last failed run (${failed.id.slice(0, 8)}) has no persisted prompt — it predates /retry support. Re-invoke it manually.\n`,
        );
        return actionResult(selection);
    }
    const mission = await readMission(location, failed.missionId).catch(() => undefined);
    const workflowName = mission?.workflowName;
    const spec = workflowName === undefined ? undefined : coding.workflowRegistry.lookup(workflowName);
    if (workflowName === undefined || spec === undefined) {
        chatOutput.write(
            `Last failed run (${failed.id.slice(0, 8)}) has no available linked workflow. Re-invoke it manually.\n`,
        );
        return actionResult(selection);
    }
    chatOutput.write(`Retrying last failed workflow "${workflowName}" with its original prompt.\n`);
    return runWorkflowAction(
        runtime,
        chatOutput,
        { kind: 'workflow', name: workflowName, prompt: failed.prompt },
        selection,
        coding,
    );
}

function emitResumeRequest(chatOutput: ChatOutput, coding: CodingActionContext, state: 'idle' | 'running'): void {
    const sessionId = coding.sessionId ?? 'interactive_session';
    coding.emitEvent?.({
        type: 'run.command.received',
        timestamp: new Date().toISOString(),
        sessionId,
        message: 'run command: resume',
        run: { command: 'resume', state },
    });
    chatOutput.write(`Resume requested for ${sessionId}\n`);
}
