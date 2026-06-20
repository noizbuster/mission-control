import type { AgentRuntime } from '@mission-control/core';
import { formatSkillInstructions, loadSkillBody, type Skill, type SkillToolOutput } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import type { ChatLineAction } from './chat-commands.js';
import type { ModelSelector } from './interactive-chat.js';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result.js';
import { runBashAction, runBashDisplayOnlyAction } from './interactive-chat-bash-action.js';
import { runClearAction } from './interactive-chat-clear-action.js';
import { slashCommandChoices } from './interactive-chat-command-menu.js';
import { runCompactAction } from './interactive-chat-compaction-action.js';
import { runExportAction } from './interactive-chat-export-action.js';
import { runHelpAction } from './interactive-chat-help-action.js';
import { runHotkeysAction } from './interactive-chat-hotkeys-action.js';
import type { ChatOutput } from './interactive-chat-io.js';
import type { ModelChoice } from './interactive-chat-model.js';
import { runModelListAction, runModelPickAction } from './interactive-chat-model-actions.js';
import {
    emitPromptAdmission,
    runBranchContinueAction,
    runSessionNavigationAction,
} from './interactive-chat-navigation-actions.js';
import { type PromptTurnContext, startPromptTurn } from './interactive-chat-prompt-turn.js';
import { runRenameAction, type SessionDisplayNameController } from './interactive-chat-rename-action.js';
import type { SessionNavigationController } from './interactive-chat-session-navigation.js';
import { formatModelProviderStatus } from './interactive-chat-status.js';
import { runTrustAction } from './interactive-chat-trust.js';
import {
    runRedoAction,
    runUndoAction,
    type UndoRedoConversationController,
} from './interactive-chat-undo-redo-action.js';
import { type ActiveCodingAgentTurn, resumeCodingAgentTurn } from './interactive-coding-agent.js';

export type CodingActionContext = PromptTurnContext & {
    readonly activeTurn: ActiveCodingAgentTurn | undefined;
    readonly sessionNavigation?: SessionNavigationController;
    /**
     * Discovered skills for `/skill-name` + `$skill` real loading (todo 10).
     * When omitted, the skill action reports that skill loading is unavailable.
     */
    readonly skills?: readonly Skill[];
    /**
     * In-memory session display name controller for `/rename`. When omitted, the
     * rename action still runs but cannot persist the name across the StatusBar.
     */
    readonly sessionDisplayName?: SessionDisplayNameController;
    /**
     * In-memory undo/redo controller for `/undo` and `/redo`. When omitted, the
     * actions report that conversation tracking is unavailable. The controller
     * never touches the durable JSONL session log.
     */
    readonly undoRedo?: UndoRedoConversationController;
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
        case 'bash':
            return runBashAction(chatOutput, currentModelProviderSelection, coding, action, (prompt) =>
                startPromptTurn(runtime, chatOutput, prompt, currentModelProviderSelection, coding),
            );
        case 'bash-display-only':
            return runBashDisplayOnlyAction(chatOutput, currentModelProviderSelection, coding, action);
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
            return runSkillAction(runtime, chatOutput, action, currentModelProviderSelection, coding);
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

async function runSkillAction(
    runtime: AgentRuntime,
    chatOutput: ChatOutput,
    action: Extract<ChatLineAction, { readonly kind: 'skill' }>,
    modelProviderSelection: ModelProviderSelection,
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    const skills = coding.skills;
    if (skills === undefined) {
        chatOutput.write('Skill loading unavailable: no workspace configured.\n');
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    const expanded = await expandSkillToPrompt(skills, action.name, action.instruction);
    if (expanded.kind === 'error') {
        chatOutput.write(expanded.message);
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    chatOutput.write(`Loading skill "${action.name}"...\n`);
    return runPromptAction(runtime, chatOutput, expanded.prompt, modelProviderSelection, coding);
}

async function expandSkillToPrompt(
    skills: readonly Skill[],
    name: string,
    instruction: string,
): Promise<
    { readonly kind: 'prompt'; readonly prompt: string } | { readonly kind: 'error'; readonly message: string }
> {
    const known = skills.some((skill) => skill.name === name);
    if (!known) {
        const available =
            skills.length === 0
                ? '(none discovered)'
                : skills
                      .slice(0, 20)
                      .map((skill) => skill.name)
                      .join(', ');
        return {
            kind: 'error',
            message: `Unknown skill: ${name}. Available skills: ${available}.\n`,
        };
    }
    let loaded: SkillToolOutput;
    try {
        loaded = await loadSkillBody(skills, name);
    } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        return { kind: 'error', message: `Failed to load skill "${name}": ${detail}\n` };
    }
    const wrapped = formatSkillInstructions(loaded.name, loaded.location, loaded.content);
    const prompt = instruction.length > 0 ? `${wrapped}\n\nUser request: ${instruction}` : wrapped;
    return { kind: 'prompt', prompt };
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
            ...(coding.engine !== undefined ? { engine: coding.engine } : {}),
            ...(coding.resolveSdkModel !== undefined ? { resolveSdkModel: coding.resolveSdkModel } : {}),
        }),
    );
}

function assertNever(value: never): never {
    throw new Error(`Unexpected chat action: ${String(value)}`);
}
