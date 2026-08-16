import {
    type AgentRuntime,
    formatSkillInstructions,
    loadSkillBody,
    type Skill,
    type SkillToolOutput,
} from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import type { ChatLineAction } from './chat-commands';
import type { CodingActionContext } from './interactive-chat-action-context';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result';
import type { ChatOutput } from './interactive-chat-io';
import { emitPromptAdmission, runSessionNavigationAction } from './interactive-chat-navigation-actions';
import { startPromptTurn } from './interactive-chat-prompt-turn';
import { clearStickyAttachBanner } from './session-attach-projection';
import { graphForDefaultFallback, modePoliciesForDefaultFallback } from './workflow-materialization';

export async function runPromptAction(
    runtime: AgentRuntime,
    chatOutput: ChatOutput,
    prompt: string,
    selection: ModelProviderSelection,
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    if (coding.activeTurn !== undefined) {
        emitPromptAdmission(chatOutput, coding, 'queue', prompt);
        return actionResult(selection, coding.activeTurn);
    }
    clearStickyAttachBanner(chatOutput);
    const fallbackGraph =
        coding.graph === undefined && coding.plainPromptGraph !== 'coding-agent'
            ? graphForDefaultFallback(coding.workflowRegistry)
            : undefined;
    // Pair the default-fallback graph with the same workflow's mode rules (almost always
    // undefined: the shipped `default` workflow declares no modes).
    const fallbackModePolicies =
        fallbackGraph === undefined ? undefined : modePoliciesForDefaultFallback(coding.workflowRegistry);
    const effectiveCoding =
        fallbackGraph === undefined
            ? coding
            : {
                  ...coding,
                  graph: fallbackGraph,
                  ...(fallbackModePolicies !== undefined ? { modePolicies: fallbackModePolicies } : {}),
              };
    return actionResult(selection, await startPromptTurn(runtime, chatOutput, prompt, selection, effectiveCoding));
}

export function runActivePromptAdmissionAction(
    chatOutput: ChatOutput,
    selection: ModelProviderSelection,
    coding: CodingActionContext,
    mode: 'queue' | 'steer',
    prompt: string,
): ChatActionResult {
    if (coding.activeTurn === undefined) {
        const actionLabel = mode === 'queue' ? 'queue behind' : 'steer';
        chatOutput.write(`No active run to ${actionLabel} — type the prompt normally to start a new run.\n`);
        return actionResult(selection);
    }
    emitPromptAdmission(chatOutput, coding, mode, prompt);
    return actionResult(selection, coding.activeTurn);
}

export async function runSessionPickerAction(
    chatOutput: ChatOutput,
    selection: ModelProviderSelection,
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    if (coding.activeTurn !== undefined) {
        chatOutput.write('Interrupt the active run before switching sessions\n');
        return actionResult(selection, coding.activeTurn);
    }
    if (coding.selectSessionForAttach === undefined) {
        chatOutput.write('Session picker is unavailable in this chat mode\n');
        return actionResult(selection);
    }
    const entries = coding.listWorkspaceSessions === undefined ? [] : await coding.listWorkspaceSessions();
    if (entries.length === 0) {
        chatOutput.write('No sessions found for this project.\n');
        return actionResult(selection);
    }
    const sessionId = await coding.selectSessionForAttach(entries);
    if (sessionId === undefined) {
        chatOutput.write('Cancelled.\n');
        return actionResult(selection);
    }
    return runSessionNavigationAction(chatOutput, coding, selection, () =>
        coding.sessionNavigation === undefined
            ? Promise.resolve(undefined)
            : coding.sessionNavigation.switchSession({ sessionId }),
    );
}

export async function runResumeLastSessionAction(
    chatOutput: ChatOutput,
    selection: ModelProviderSelection,
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    if (coding.activeTurn !== undefined) {
        chatOutput.write('Interrupt the active run before switching sessions\n');
        return actionResult(selection, coding.activeTurn);
    }
    const entries = coding.listWorkspaceSessions === undefined ? [] : await coding.listWorkspaceSessions();
    const target = entries.find((entry) => entry.sessionId !== coding.sessionId);
    if (target === undefined) {
        chatOutput.write('No previous session for this project.\n');
        return actionResult(selection);
    }
    return runSessionNavigationAction(chatOutput, coding, selection, () =>
        coding.sessionNavigation === undefined
            ? Promise.resolve(undefined)
            : coding.sessionNavigation.switchSession({ sessionId: target.sessionId }),
    );
}

export async function runSkillAction(
    runtime: AgentRuntime,
    chatOutput: ChatOutput,
    action: Extract<ChatLineAction, { readonly kind: 'skill' }>,
    selection: ModelProviderSelection,
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    if (coding.skills === undefined) {
        chatOutput.write('Skill loading unavailable: no workspace configured.\n');
        return actionResult(selection, coding.activeTurn);
    }
    const expanded = await expandSkillToPrompt(coding.skills, action.name, action.instruction);
    if (expanded.kind === 'error') {
        chatOutput.write(expanded.message);
        return actionResult(selection, coding.activeTurn);
    }
    chatOutput.write(`Loading skill "${action.name}"...\n`);
    chatOutput.showNotice?.(`Skill: ${action.name}`);
    return runPromptAction(runtime, chatOutput, expanded.prompt, selection, coding);
}

async function expandSkillToPrompt(
    skills: readonly Skill[],
    name: string,
    instruction: string,
): Promise<
    { readonly kind: 'prompt'; readonly prompt: string } | { readonly kind: 'error'; readonly message: string }
> {
    if (!skills.some((skill) => skill.name === name)) {
        const available =
            skills.length === 0
                ? '(none discovered)'
                : skills
                      .slice(0, 20)
                      .map((skill) => skill.name)
                      .join(', ');
        return { kind: 'error', message: `Unknown skill: ${name}. Available skills: ${available}.\n` };
    }
    let loaded: SkillToolOutput;
    try {
        loaded = await loadSkillBody(skills, name);
    } catch (error: unknown) {
        return {
            kind: 'error',
            message: `Failed to load skill "${name}": ${error instanceof Error ? error.message : String(error)}\n`,
        };
    }
    const wrapped = formatSkillInstructions(loaded.name, loaded.location, loaded.content);
    return { kind: 'prompt', prompt: instruction.length > 0 ? `${wrapped}\n\nUser request: ${instruction}` : wrapped };
}
