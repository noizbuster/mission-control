import type { AgentRuntime } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import { type ModelChoice, slashCommandChoices } from '@mission-control/tui/state';
import type { ChatLineAction } from './chat-commands';
import { runAgentsAction, runSkillsAction } from './interactive-agent-actions';
import { runApprovalAction } from './interactive-approval-action';
import type { ModelSelector } from './interactive-chat';
import type { CodingActionContext } from './interactive-chat-action-context';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result';
import { runBashAction, runBashDisplayOnlyAction } from './interactive-chat-bash-action';
import { runClearAction } from './interactive-chat-clear-action';
import { runCompactAction } from './interactive-chat-compaction-action';
import { runExportAction } from './interactive-chat-export-action';
import { runHelpAction } from './interactive-chat-help-action';
import { runHotkeysAction } from './interactive-chat-hotkeys-action';
import type { ChatOutput } from './interactive-chat-io';
import { runModelListAction, runModelPickAction, runModelSelectionAction } from './interactive-chat-model-actions';
import { runBranchContinueAction, runSessionNavigationAction } from './interactive-chat-navigation-actions';
import { startPromptTurn } from './interactive-chat-prompt-turn';
import { runRenameAction } from './interactive-chat-rename-action';
import { runTrustAction } from './interactive-chat-trust';
import { runRedoAction, runUndoAction } from './interactive-chat-undo-redo-action';
import { runMissionAction, runModelsAction } from './interactive-mission-actions';
import {
    runActivePromptAdmissionAction,
    runPromptAction,
    runResumeLastSessionAction,
    runSessionPickerAction,
    runSkillAction,
} from './interactive-prompt-actions';
import { runWorkflowAction } from './interactive-workflow-actions';
import { runApprovalResumeAction, runInterruptAction, runRetryAction } from './interactive-workflow-resume-actions';

export { loadDashboardAgentEntries } from './interactive-agent-actions';
export type { CodingActionContext } from './interactive-chat-action-context';
export { loadMissionPanelRows } from './interactive-mission-actions';
export { startWorkflowTurn } from './interactive-workflow-actions';

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
        case 'bash':
            return runBashAction(chatOutput, currentModelProviderSelection, coding, action, (prompt) =>
                startPromptTurn(runtime, chatOutput, prompt, currentModelProviderSelection, coding),
            );
        case 'bash-display-only':
            return runBashDisplayOnlyAction(chatOutput, currentModelProviderSelection, coding, action);
        case 'queue':
            return runActivePromptAdmissionAction(
                chatOutput,
                currentModelProviderSelection,
                coding,
                'queue',
                action.prompt,
            );
        case 'steer':
            return runActivePromptAdmissionAction(
                chatOutput,
                currentModelProviderSelection,
                coding,
                'steer',
                action.prompt,
            );
        case 'branch':
            return action.mode === 'continue' && action.prompt !== undefined
                ? runBranchContinueAction(
                      chatOutput,
                      coding,
                      currentModelProviderSelection,
                      action.entryId,
                      action.prompt,
                  )
                : runSessionNavigationAction(
                      chatOutput,
                      coding,
                      currentModelProviderSelection,
                      () =>
                          coding.sessionNavigation === undefined
                              ? Promise.resolve(undefined)
                              : coding.sessionNavigation.selectBranch({
                                    entryId: action.entryId,
                                    modelProviderSelection: currentModelProviderSelection,
                                }),
                      { requiresCurrentSession: true },
                  );
        case 'resume':
            return runResumeLastSessionAction(chatOutput, currentModelProviderSelection, coding);
        case 'new-session':
            return runSessionNavigationAction(chatOutput, coding, currentModelProviderSelection, () =>
                coding.sessionNavigation === undefined
                    ? Promise.resolve(undefined)
                    : coding.sessionNavigation.startNewSession({
                          modelProviderSelection: currentModelProviderSelection,
                          ...(action.sessionId !== undefined ? { sessionId: action.sessionId } : {}),
                      }),
            );
        case 'clear':
            return runClearAction(chatOutput, coding, currentModelProviderSelection, action);
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
            return coding.selectSessionForAttach !== undefined
                ? runSessionPickerAction(chatOutput, currentModelProviderSelection, coding)
                : runSessionNavigationAction(chatOutput, coding, currentModelProviderSelection, () =>
                      coding.sessionNavigation === undefined
                          ? Promise.resolve(undefined)
                          : coding.sessionNavigation.listSessions(),
                  );
        case 'tree':
            return runSessionNavigationAction(
                chatOutput,
                coding,
                currentModelProviderSelection,
                () =>
                    coding.sessionNavigation === undefined
                        ? Promise.resolve(undefined)
                        : coding.sessionNavigation.showTree({
                              ...(action.sessionId !== undefined ? { sessionId: action.sessionId } : {}),
                          }),
                { requiresCurrentSession: action.sessionId === undefined },
            );
        case 'fork':
            return runSessionNavigationAction(
                chatOutput,
                coding,
                currentModelProviderSelection,
                () =>
                    coding.sessionNavigation === undefined
                        ? Promise.resolve(undefined)
                        : coding.sessionNavigation.forkSession({
                              entryId: action.entryId,
                              modelProviderSelection: currentModelProviderSelection,
                              ...(action.sessionId !== undefined ? { sessionId: action.sessionId } : {}),
                          }),
                { requiresCurrentSession: true },
            );
        case 'clone':
            return runSessionNavigationAction(
                chatOutput,
                coding,
                currentModelProviderSelection,
                () =>
                    coding.sessionNavigation === undefined
                        ? Promise.resolve(undefined)
                        : coding.sessionNavigation.cloneSession({
                              modelProviderSelection: currentModelProviderSelection,
                              ...(action.sessionId !== undefined ? { sessionId: action.sessionId } : {}),
                          }),
                { requiresCurrentSession: true },
            );
        case 'compact':
            return runCompactAction(runtime, chatOutput, currentModelProviderSelection, coding, action.instructions);
        case 'export':
            return runExportAction(chatOutput, currentModelProviderSelection, coding, action);
        case 'rename':
            return runRenameAction(
                chatOutput,
                currentModelProviderSelection,
                action,
                coding.sessionDisplayName,
                coding.activeTurn,
                coding.onSessionRenamed,
            );
        case 'undo':
            return runUndoAction(chatOutput, currentModelProviderSelection, coding.undoRedo, coding.activeTurn);
        case 'redo':
            return runRedoAction(chatOutput, currentModelProviderSelection, coding.undoRedo, coding.activeTurn);
        case 'help':
            return runHelpAction(chatOutput, slashCommandChoices, currentModelProviderSelection, coding.activeTurn);
        case 'hotkeys':
            return runHotkeysAction(chatOutput, currentModelProviderSelection, coding.activeTurn);
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
            return runModelSelectionAction(runtime, chatOutput, action.selection, coding.activeTurn);
        case 'trust':
            if (coding.workspaceRoot === undefined) {
                chatOutput.write('Trust command unavailable: workspace root is unavailable\n');
                return actionResult(currentModelProviderSelection, coding.activeTurn);
            }
            await runTrustAction(chatOutput, action.action, coding.workspaceRoot);
            return actionResult(currentModelProviderSelection, coding.activeTurn);
        case 'approval':
            return runApprovalAction(
                chatOutput,
                currentModelProviderSelection,
                action.level,
                coding.activeTurn,
                coding.approvalLevel,
                coding.selectApprovalLevel,
            );
        case 'skill':
            return runSkillAction(runtime, chatOutput, action, currentModelProviderSelection, coding);
        case 'workflow':
            return runWorkflowAction(runtime, chatOutput, action, currentModelProviderSelection, coding);
        case 'agents':
            return runAgentsAction(chatOutput, currentModelProviderSelection, coding, action.agents);
        case 'skills':
            return runSkillsAction(chatOutput, currentModelProviderSelection, coding, action.skills);
        case 'mission':
            return runMissionAction(chatOutput, currentModelProviderSelection, coding);
        case 'models':
            return runModelsAction(chatOutput, currentModelProviderSelection, modelChoices, coding);
        case 'unknown-slash':
            chatOutput.write(`Unknown command: /${action.command}\n`);
            return actionResult(currentModelProviderSelection, coding.activeTurn);
        case 'invalid':
            chatOutput.write(`${action.message}\n`);
            return actionResult(currentModelProviderSelection, coding.activeTurn);
        case 'session-picker':
            return runSessionPickerAction(chatOutput, currentModelProviderSelection, coding);
        case 'continue':
            return runApprovalResumeAction(chatOutput, currentModelProviderSelection, coding);
        case 'retry':
            return runRetryAction(runtime, chatOutput, currentModelProviderSelection, coding);
        default:
            throw new Error(`Unexpected chat action: ${String(action)}`);
    }
}
