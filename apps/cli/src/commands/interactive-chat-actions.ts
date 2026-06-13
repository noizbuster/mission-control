import type { AgentRuntime } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import type { ChatLineAction } from './chat-commands.js';
import type { ModelSelector } from './interactive-chat.js';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result.js';
import { runCompactAction } from './interactive-chat-compaction-action.js';
import type { ChatOutput } from './interactive-chat-io.js';
import type { ModelChoice } from './interactive-chat-model.js';
import { runModelListAction, runModelPickAction } from './interactive-chat-model-actions.js';
import {
    emitPromptAdmission,
    runBranchContinueAction,
    runSessionNavigationAction,
} from './interactive-chat-navigation-actions.js';
import { type PromptTurnContext, startPromptTurn } from './interactive-chat-prompt-turn.js';
import type { SessionNavigationController } from './interactive-chat-session-navigation.js';
import { formatModelProviderStatus } from './interactive-chat-status.js';
import { runTrustAction } from './interactive-chat-trust.js';
import { type ActiveCodingAgentTurn, resumeCodingAgentTurn } from './interactive-coding-agent.js';

export type CodingActionContext = PromptTurnContext & {
    readonly activeTurn: ActiveCodingAgentTurn | undefined;
    readonly sessionNavigation?: SessionNavigationController;
};

export async function runChatAction(
    runtime: AgentRuntime,
    chatOutput: ChatOutput,
    action: ChatLineAction,
    currentModelProviderSelection: ModelProviderSelection,
    selectModel: ModelSelector,
    modelChoices: readonly ModelChoice[],
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    switch (action.kind) {
        case 'empty':
            return actionResult(currentModelProviderSelection);
        case 'prompt':
            return runPromptAction(runtime, chatOutput, action.prompt, currentModelProviderSelection, coding);
        case 'queue':
            emitPromptAdmission(chatOutput, coding, 'queue', action.prompt);
            return actionResult(currentModelProviderSelection, coding.activeTurn);
        case 'steer':
            emitPromptAdmission(chatOutput, coding, 'steer', action.prompt);
            return actionResult(currentModelProviderSelection, coding.activeTurn);
        case 'branch':
            return action.mode === 'continue' && action.prompt !== undefined
                ? runBranchContinueAction(
                      chatOutput,
                      coding,
                      currentModelProviderSelection,
                      action.entryId,
                      action.prompt,
                  )
                : runSessionNavigationAction(chatOutput, coding, currentModelProviderSelection, () =>
                      coding.sessionNavigation === undefined
                          ? Promise.resolve(undefined)
                          : coding.sessionNavigation.selectBranch({
                                entryId: action.entryId,
                                modelProviderSelection: currentModelProviderSelection,
                            }),
                  );
        case 'resume':
            return runResumeAction(chatOutput, currentModelProviderSelection, coding);
        case 'new-session':
            return runSessionNavigationAction(chatOutput, coding, currentModelProviderSelection, () =>
                coding.sessionNavigation === undefined
                    ? Promise.resolve(undefined)
                    : coding.sessionNavigation.startNewSession({
                          modelProviderSelection: currentModelProviderSelection,
                          ...(action.sessionId !== undefined ? { sessionId: action.sessionId } : {}),
                      }),
            );
        case 'session':
            return runSessionNavigationAction(chatOutput, coding, currentModelProviderSelection, () =>
                action.sessionId === undefined
                    ? coding.sessionNavigation === undefined
                        ? Promise.resolve(undefined)
                        : coding.sessionNavigation.showSession({})
                    : coding.sessionNavigation === undefined
                      ? Promise.resolve(undefined)
                      : coding.sessionNavigation.switchSession({ sessionId: action.sessionId }),
            );
        case 'sessions':
            return runSessionNavigationAction(chatOutput, coding, currentModelProviderSelection, () =>
                coding.sessionNavigation === undefined
                    ? Promise.resolve(undefined)
                    : coding.sessionNavigation.listSessions(),
            );
        case 'tree':
            return runSessionNavigationAction(chatOutput, coding, currentModelProviderSelection, () =>
                coding.sessionNavigation === undefined
                    ? Promise.resolve(undefined)
                    : coding.sessionNavigation.showTree({
                          ...(action.sessionId !== undefined ? { sessionId: action.sessionId } : {}),
                      }),
            );
        case 'fork':
            return runSessionNavigationAction(chatOutput, coding, currentModelProviderSelection, () =>
                coding.sessionNavigation === undefined
                    ? Promise.resolve(undefined)
                    : coding.sessionNavigation.forkSession({
                          entryId: action.entryId,
                          modelProviderSelection: currentModelProviderSelection,
                          ...(action.sessionId !== undefined ? { sessionId: action.sessionId } : {}),
                      }),
            );
        case 'clone':
            return runSessionNavigationAction(chatOutput, coding, currentModelProviderSelection, () =>
                coding.sessionNavigation === undefined
                    ? Promise.resolve(undefined)
                    : coding.sessionNavigation.cloneSession({
                          modelProviderSelection: currentModelProviderSelection,
                          ...(action.sessionId !== undefined ? { sessionId: action.sessionId } : {}),
                      }),
            );
        case 'compact':
            return runCompactAction(runtime, chatOutput, currentModelProviderSelection, coding);
        case 'interrupt':
            return runInterruptAction(chatOutput, currentModelProviderSelection, coding.activeTurn);
        case 'exit':
            return actionResult(currentModelProviderSelection, coding.activeTurn);
        case 'model-pick':
            return runModelPickAction(
                runtime,
                chatOutput,
                currentModelProviderSelection,
                selectModel,
                modelChoices,
                coding,
            );
        case 'model-list':
            return runModelListAction(chatOutput, currentModelProviderSelection, action, coding.activeTurn);
        case 'model':
            runtime.setModelProviderSelection(action.selection);
            chatOutput.write(formatModelProviderStatus(action.selection, { nodeMode: 'none' }));
            return actionResult(action.selection, coding.activeTurn, { persistModelProviderSelection: true });
        case 'trust':
            if (coding.workspaceRoot === undefined) {
                chatOutput.write('Trust command unavailable: workspace root is unavailable\n');
                return actionResult(currentModelProviderSelection, coding.activeTurn);
            }
            await runTrustAction(chatOutput, action.action, coding.workspaceRoot);
            return actionResult(currentModelProviderSelection, coding.activeTurn);
        case 'skill':
            await runtime.runSkillInvocationTask({ skillID: action.name, argumentsText: action.instruction });
            chatOutput.write(
                `Skill ${action.name} scaffolded${action.instruction.length > 0 ? `: ${action.instruction}` : ''}\n`,
            );
            return actionResult(currentModelProviderSelection, coding.activeTurn);
        case 'unknown-slash':
            chatOutput.write(`Unknown command: /${action.command}\n`);
            return actionResult(currentModelProviderSelection, coding.activeTurn);
        case 'invalid':
            chatOutput.write(`${action.message}\n`);
            return actionResult(currentModelProviderSelection, coding.activeTurn);
        default:
            return assertNever(action);
    }
}

async function runPromptAction(
    runtime: AgentRuntime,
    chatOutput: ChatOutput,
    prompt: string,
    modelProviderSelection: ModelProviderSelection,
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    if (coding.activeTurn !== undefined) {
        emitPromptAdmission(chatOutput, coding, 'queue', prompt);
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    return actionResult(
        modelProviderSelection,
        await startPromptTurn(runtime, chatOutput, prompt, modelProviderSelection, coding),
    );
}

async function runInterruptAction(
    chatOutput: ChatOutput,
    modelProviderSelection: ModelProviderSelection,
    activeTurn: ActiveCodingAgentTurn | undefined,
): Promise<ChatActionResult> {
    if (activeTurn === undefined) {
        chatOutput.write('No active run to interrupt\n');
        return actionResult(modelProviderSelection);
    }
    activeTurn.interrupt('force');
    await activeTurn.done;
    return actionResult(modelProviderSelection);
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

async function runResumeAction(
    chatOutput: ChatOutput,
    modelProviderSelection: ModelProviderSelection,
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    if (coding.activeTurn !== undefined) {
        emitResumeRequest(chatOutput, coding, 'running');
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    if (
        coding.provider === undefined ||
        coding.sessionId === undefined ||
        coding.workspaceRoot === undefined ||
        coding.sessionStore === undefined
    ) {
        emitResumeRequest(chatOutput, coding, 'idle');
        return actionResult(modelProviderSelection);
    }
    chatOutput.write(`Resuming blocked run for ${coding.sessionId}\n`);
    return actionResult(
        modelProviderSelection,
        await resumeCodingAgentTurn({
            sessionId: coding.sessionId,
            turnId: coding.nextTurnId(),
            store: coding.sessionStore,
            provider: coding.provider,
            modelProviderSelection,
            workspaceRoot: coding.workspaceRoot,
            output: chatOutput,
            emitEvent: coding.emitEvent ?? (() => undefined),
            ...(coding.observeStoredEvent !== undefined ? { observeStoredEvent: coding.observeStoredEvent } : {}),
            ...(coding.commandExecutor !== undefined ? { commandExecutor: coding.commandExecutor } : {}),
        }),
    );
}

function assertNever(value: never): never {
    throw new Error(`Unexpected chat action: ${String(value)}`);
}
