import {
    AgentIndex,
    type AgentRuntime,
    bustSkillCache,
    completeRun,
    createMission,
    discoverAgents,
    discoverSkills,
    ensureOmoDirs,
    failRun,
    findMostRecentFailedRun,
    formatSkillInstructions,
    listMissions,
    listRunsForMission,
    loadSkillBody,
    materializeMission,
    readMission,
    resolveOmoRoot,
    resolveUserConfigDir,
    type Skill,
    type SkillToolOutput,
    startRun,
    type WorkflowRegistry,
} from '@mission-control/core';
import type {
    AbgGraphSpec,
    AgentDefinition,
    AgentEvent,
    Mission,
    ModelProviderSelection,
    Run,
    WorkflowSpec,
} from '@mission-control/protocol';
import type {
    ApprovalLevel,
    DashboardAgentEntry,
    MissionPanelRow,
    SessionPickerEntry,
} from '@mission-control/tui/state';
import {
    APPROVAL_LEVEL_META,
    createModelsOverlayRoleRows,
    createVariantChoices,
    type ModelChoice,
    type ModelsOverlayRoleRow,
    slashCommandChoices,
} from '@mission-control/tui/state';
import type { ProviderAuthStore } from '../auth-store.js';
import { type AgentsCommand, formatAgentDetails, formatAgentsList } from './agents-command.js';
import { readDisabledSet, toggleDisabled } from './agents-disabled-config.js';
import { readOverridesMap } from './agents-model-overrides-config.js';
import type { ChatLineAction, SkillsCommand, WorkflowInvocationAction } from './chat-commands.js';
import type { ModelSelector, PlainPromptGraph } from './interactive-chat.js';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result.js';
import { runBashAction, runBashDisplayOnlyAction } from './interactive-chat-bash-action.js';
import { runClearAction } from './interactive-chat-clear-action.js';
import { runCompactAction } from './interactive-chat-compaction-action.js';
import { runExportAction } from './interactive-chat-export-action.js';
import { runHelpAction } from './interactive-chat-help-action.js';
import { runHotkeysAction } from './interactive-chat-hotkeys-action.js';
import type { ChatOutput } from './interactive-chat-io.js';
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
import { graphForDefaultFallback, graphForWorkflowSpec } from './workflow-materialization.js';

export type CodingActionContext = PromptTurnContext & {
    readonly activeTurn: ActiveCodingAgentTurn | undefined;
    readonly useTui: boolean;
    readonly sessionNavigation?: SessionNavigationController;
    /**
     * Discovered skills for `/skill-name` + `$skill` real loading (todo 10).
     * When omitted, the skill action reports that skill loading is unavailable.
     */
    readonly skills?: readonly Skill[];
    /**
     * Discovered workflows for `#workflow-name` invocation (Task 2.3) and for the
     * model-self-invoke `workflow(name, prompt)` tool. When omitted, both paths
     * report that workflow invocation is unavailable.
     */
    readonly workflowRegistry?: WorkflowRegistry;
    readonly plainPromptGraph?: PlainPromptGraph;
    /**
     * In-memory session display name controller for `/rename`. When omitted, the
     * rename action still runs but cannot persist the name across the StatusBar.
     */
    readonly sessionDisplayName?: SessionDisplayNameController;
    /**
     * Side-effect hook fired after a rename resolves (Ctrl+R overlay or
     * `/rename <name>` slash command). Owns store/title/durable persistence
     * updates. Optional so test contexts can omit it.
     */
    readonly onSessionRenamed?: (name: string) => Promise<void>;
    /**
     * In-memory undo/redo controller for `/undo` and `/redo`. When omitted, the
     * actions report that conversation tracking is unavailable. The controller
     * never touches the durable session store.
     */
    readonly undoRedo?: UndoRedoConversationController;
    readonly selectApprovalLevel?: (currentLevel?: ApprovalLevel) => Promise<ApprovalLevel | undefined>;
    /**
     * Workspace-filtered session catalog entries for `/session` (picker) and `/resume`
     * (last-session). When omitted, both commands report that no sessions are available.
     */
    readonly listWorkspaceSessions?: () => Promise<readonly SessionPickerEntry[]>;
    /**
     * Opens the session-picker modal and resolves to the selected sessionId, or undefined
     * when cancelled. Only available in TUI mode through the active TUI handle.
     */
    readonly selectSessionForAttach?: (entries: readonly SessionPickerEntry[]) => Promise<string | undefined>;
    readonly openAgentsDashboard?: (entries: readonly DashboardAgentEntry[]) => void;
    readonly reloadAgentsDashboard?: (entries: readonly DashboardAgentEntry[]) => void;
    readonly openMissionPanel?: (rows: readonly MissionPanelRow[]) => void;
    readonly reloadMissionPanel?: (rows: readonly MissionPanelRow[]) => void;
    readonly openModelsOverlay?: (
        entries: readonly ModelProviderSelection[],
        roleRows: readonly ModelsOverlayRoleRow[],
    ) => void;
    readonly authStore?: ProviderAuthStore;
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
            if (coding.activeTurn === undefined) {
                chatOutput.write('No active run to queue behind — type the prompt normally to start a new run.\n');
                return actionResult(currentModelProviderSelection);
            }
            emitPromptAdmission(chatOutput, coding, 'queue', action.prompt);
            return actionResult(currentModelProviderSelection, coding.activeTurn);
        case 'steer':
            if (coding.activeTurn === undefined) {
                chatOutput.write('No active run to steer — type the prompt normally to start a new run.\n');
                return actionResult(currentModelProviderSelection);
            }
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
            if (coding.selectSessionForAttach !== undefined) {
                return runSessionPickerAction(chatOutput, currentModelProviderSelection, coding);
            }
            return runSessionNavigationAction(chatOutput, coding, currentModelProviderSelection, () =>
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
    const fallbackGraph =
        coding.graph === undefined && coding.plainPromptGraph !== 'coding-agent'
            ? graphForDefaultFallback(coding.workflowRegistry)
            : undefined;
    const effectiveCoding = fallbackGraph !== undefined ? { ...coding, graph: fallbackGraph } : coding;
    return actionResult(
        modelProviderSelection,
        await startPromptTurn(runtime, chatOutput, prompt, modelProviderSelection, effectiveCoding),
    );
}

async function runSessionPickerAction(
    chatOutput: ChatOutput,
    modelProviderSelection: ModelProviderSelection,
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    if (coding.activeTurn !== undefined) {
        chatOutput.write('Interrupt the active run before switching sessions\n');
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    if (coding.selectSessionForAttach === undefined) {
        chatOutput.write('Session picker is unavailable in this chat mode\n');
        return actionResult(modelProviderSelection);
    }
    const entries = coding.listWorkspaceSessions === undefined ? [] : await coding.listWorkspaceSessions();
    if (entries.length === 0) {
        chatOutput.write('No sessions found for this project.\n');
        return actionResult(modelProviderSelection);
    }
    const selected = await coding.selectSessionForAttach(entries);
    if (selected === undefined) {
        chatOutput.write('Cancelled.\n');
        return actionResult(modelProviderSelection);
    }
    return runSessionNavigationAction(chatOutput, coding, modelProviderSelection, () =>
        coding.sessionNavigation === undefined
            ? Promise.resolve(undefined)
            : coding.sessionNavigation.switchSession({ sessionId: selected }),
    );
}

async function runResumeLastSessionAction(
    chatOutput: ChatOutput,
    modelProviderSelection: ModelProviderSelection,
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    if (coding.activeTurn !== undefined) {
        chatOutput.write('Interrupt the active run before switching sessions\n');
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    const entries = coding.listWorkspaceSessions === undefined ? [] : await coding.listWorkspaceSessions();
    const target = entries.find((entry) => entry.sessionId !== coding.sessionId);
    if (target === undefined) {
        chatOutput.write('No previous session for this project.\n');
        return actionResult(modelProviderSelection);
    }
    return runSessionNavigationAction(chatOutput, coding, modelProviderSelection, () =>
        coding.sessionNavigation === undefined
            ? Promise.resolve(undefined)
            : coding.sessionNavigation.switchSession({ sessionId: target.sessionId }),
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
    chatOutput.showNotice?.(`Skill: ${action.name}`);
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

async function runWorkflowAction(
    runtime: AgentRuntime,
    chatOutput: ChatOutput,
    action: WorkflowInvocationAction,
    modelProviderSelection: ModelProviderSelection,
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    const registry = coding.workflowRegistry;
    if (registry === undefined) {
        chatOutput.write('Workflow invocation unavailable: no workflow registry configured.\n');
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    const spec = registry.lookup(action.name);
    if (spec === undefined) {
        const names = registry.names();
        const available = names.length === 0 ? '(none discovered)' : names.slice(0, 20).join(', ');
        chatOutput.write(`Unknown workflow: ${action.name}. Available workflows: ${available}.\n`);
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    chatOutput.write(`Running workflow "${action.name}"...\n`);
    chatOutput.showNotice?.(`Workflow: ${action.name}`);
    const workflowGraph = graphForWorkflowSpec(spec);
    seedOverlayForWorkflow(coding, workflowGraph);

    // Only persist when a fresh turn starts; a queued prompt runs behind an existing turn.
    const runHandle =
        coding.activeTurn === undefined
            ? await tryCreateWorkflowRun(coding.workspaceRoot, spec, action.prompt)
            : undefined;

    if (runHandle === undefined) {
        return runPromptAction(runtime, chatOutput, action.prompt, modelProviderSelection, {
            ...coding,
            graph: workflowGraph,
        });
    }

    const tracker = createRunOutcomeTracker();
    const result = await runPromptAction(runtime, chatOutput, action.prompt, modelProviderSelection, {
        ...coding,
        graph: workflowGraph,
        emitEvent: (event: AgentEvent) => {
            tracker.observe(event);
            coding.emitEvent?.(event);
        },
    });

    if (result.activeTurn !== undefined) {
        void result.activeTurn.done.then(() => {
            void settleWorkflowRun(runHandle, tracker.getOutcome());
        });
    } else {
        // Turn settled inline; a 'pending' outcome means no terminal event fired (e.g. no provider).
        const outcome = tracker.getOutcome();
        await settleWorkflowRun(runHandle, outcome === 'pending' ? 'failed' : outcome);
    }

    return result;
}

type WorkflowRunHandle = {
    readonly omoRoot: string;
    readonly missionId: string;
    readonly runId: string;
};

type WorkflowRunOutcome = 'completed' | 'failed' | 'pending';

/**
 * Best-effort Mission/Run creation. Returns undefined when the workspace has no
 * `.omo` root so the workflow proceeds without records.
 */
async function tryCreateWorkflowRun(
    workspaceRoot: string | undefined,
    spec: WorkflowSpec,
    prompt: string,
): Promise<WorkflowRunHandle | undefined> {
    if (workspaceRoot === undefined) return undefined;
    let omoRoot: string;
    try {
        omoRoot = await resolveOmoRoot(workspaceRoot);
    } catch {
        return undefined;
    }
    await ensureOmoDirs(omoRoot);
    const mission = materializeMission(spec);
    await createMission(omoRoot, mission);
    const run = await startRun(omoRoot, mission.id, prompt);
    return { omoRoot, missionId: mission.id, runId: run.id };
}

function createRunOutcomeTracker(): {
    readonly observe: (event: AgentEvent) => void;
    readonly getOutcome: () => WorkflowRunOutcome;
} {
    let outcome: WorkflowRunOutcome = 'pending';
    return {
        observe(event: AgentEvent): void {
            if (outcome !== 'pending') return;
            if (event.type === 'task.completed') {
                outcome = 'completed';
            } else if (event.type === 'task.failed') {
                outcome = 'failed';
            }
        },
        getOutcome(): WorkflowRunOutcome {
            return outcome;
        },
    };
}

/**
 * 'pending' is a no-op — the turn is blocked or still running, so the Run stays 'running'.
 */
async function settleWorkflowRun(handle: WorkflowRunHandle, outcome: WorkflowRunOutcome): Promise<void> {
    if (outcome === 'completed') {
        await completeRun(handle.omoRoot, handle.runId).catch(() => undefined);
    } else if (outcome === 'failed') {
        await failRun(handle.omoRoot, handle.runId, 'workflow turn failed').catch(() => undefined);
    }
}

export async function startWorkflowTurn(
    runtime: AgentRuntime,
    chatOutput: ChatOutput,
    spec: WorkflowSpec,
    prompt: string,
    modelProviderSelection: ModelProviderSelection,
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    chatOutput.write(`Running workflow "${spec.name}"...\n`);
    chatOutput.showNotice?.(`Workflow: ${spec.name}`);
    const workflowGraph = graphForWorkflowSpec(spec);
    seedOverlayForWorkflow(coding, workflowGraph);
    return runPromptAction(runtime, chatOutput, prompt, modelProviderSelection, {
        ...coding,
        activeTurn: undefined,
        graph: workflowGraph,
    });
}

function seedOverlayForWorkflow(coding: CodingActionContext, graph: AbgGraphSpec): void {
    const controller = coding.abgOverlayController;
    if (controller === undefined) return;
    controller.store.update((draft) => {
        const nodes = new Map(draft.nodes);
        for (const node of graph.nodes) {
            if (!nodes.has(node.id)) {
                nodes.set(node.id, 'idle');
            }
        }
        draft.activeGraphId = graph.id;
        draft.graphStatus = 'active';
        draft.nodes = nodes;
        draft.graphEdges = graph.edges.map((edge) => ({
            source: edge.source,
            target: edge.target,
            ...(edge.condition !== undefined ? { condition: edge.condition } : {}),
        }));
    });
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

async function runApprovalResumeAction(
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
        chatOutput.write('Nothing to resume — no provider/session configured. Send a prompt to start a run.\n');
        return actionResult(modelProviderSelection);
    }
    chatOutput.write(`Resuming run for ${coding.sessionId}\n`);
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
            ...(coding.requestUserQuestion !== undefined ? { requestUserQuestion: coding.requestUserQuestion } : {}),
            ...(coding.requestUserQuestions !== undefined ? { requestUserQuestions: coding.requestUserQuestions } : {}),
            ...(coding.abgOverlayController !== undefined ? { abgOverlayController: coding.abgOverlayController } : {}),
            ...(coding.pricingTable !== undefined ? { pricingTable: coding.pricingTable } : {}),
            ...(coding.permissionSession !== undefined ? { permissionSession: coding.permissionSession } : {}),
            ...(coding.onUsage !== undefined ? { onUsage: coding.onUsage } : {}),
            ...(coding.authStore !== undefined ? { authStore: coding.authStore } : {}),
            ...(coding.profileName !== undefined ? { profileName: coding.profileName } : {}),
        }),
    );
}

// `/retry` re-runs the last FAILED workflow with its original prompt; `/continue` only resumes a run
// blocked on approval. The prompt is recovered from the Run record (startRun persists it).
async function runRetryAction(
    runtime: AgentRuntime,
    chatOutput: ChatOutput,
    modelProviderSelection: ModelProviderSelection,
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    if (coding.activeTurn !== undefined) {
        chatOutput.write('A turn is already running. Interrupt it first (/interrupt or Ctrl+C twice).\n');
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    if (coding.workspaceRoot === undefined || coding.workflowRegistry === undefined) {
        chatOutput.write('Retry unavailable: no workspace or workflow registry.\n');
        return actionResult(modelProviderSelection);
    }
    let omoRoot: string;
    try {
        omoRoot = await resolveOmoRoot(coding.workspaceRoot);
    } catch {
        chatOutput.write('Retry unavailable: no .omo root for this workspace.\n');
        return actionResult(modelProviderSelection);
    }
    const failed = await findMostRecentFailedRun(omoRoot);
    if (failed === undefined) {
        chatOutput.write('No failed run to retry. Type a prompt or use #<workflow> {prompt} to start a new run.\n');
        return actionResult(modelProviderSelection);
    }
    if (failed.prompt === undefined) {
        chatOutput.write(
            `Last failed run (${failed.id.slice(0, 8)}) has no persisted prompt — it predates /retry support. Re-invoke it manually.\n`,
        );
        return actionResult(modelProviderSelection);
    }
    const mission = await readMission(omoRoot, failed.missionId).catch(() => undefined);
    const workflowName = mission?.workflowName;
    if (workflowName === undefined) {
        chatOutput.write(`Last failed run (${failed.id.slice(0, 8)}) has no linked workflow. Re-invoke it manually.\n`);
        return actionResult(modelProviderSelection);
    }
    const spec = coding.workflowRegistry.lookup(workflowName);
    if (spec === undefined) {
        chatOutput.write(
            `Workflow "${workflowName}" from the last failed run is no longer available. Type a new prompt.\n`,
        );
        return actionResult(modelProviderSelection);
    }
    chatOutput.write(`Retrying last failed workflow "${workflowName}" with its original prompt.\n`);
    return runWorkflowAction(
        runtime,
        chatOutput,
        { kind: 'workflow', name: workflowName, prompt: failed.prompt },
        modelProviderSelection,
        coding,
    );
}

function assertNever(value: never): never {
    throw new Error(`Unexpected chat action: ${String(value)}`);
}

async function runAgentsAction(
    chatOutput: ChatOutput,
    modelProviderSelection: ModelProviderSelection,
    coding: CodingActionContext,
    command: AgentsCommand,
): Promise<ChatActionResult> {
    if (coding.workspaceRoot === undefined) {
        chatOutput.write('Agents command unavailable: workspace root is unavailable\n');
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    if (command.kind === 'invalid') {
        chatOutput.write(`${command.message}\n`);
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    const workspaceRoot = coding.workspaceRoot;
    const userConfigDir = resolveUserConfigDir();

    if (command.kind === 'dashboard') {
        if (!coding.useTui || coding.openAgentsDashboard === undefined) {
            const agents = await loadDiscoveredAgents(workspaceRoot, userConfigDir);
            chatOutput.write(formatAgentsList(agents));
            return actionResult(modelProviderSelection, coding.activeTurn);
        }
        const entries = await loadDashboardAgentEntries(workspaceRoot, userConfigDir);
        if (entries.length === 0) {
            chatOutput.write('No agents discovered.\n');
            return actionResult(modelProviderSelection, coding.activeTurn);
        }
        coding.openAgentsDashboard(entries);
        return actionResult(modelProviderSelection, coding.activeTurn);
    }

    if (command.kind === 'list') {
        const agents = await loadDiscoveredAgents(workspaceRoot, userConfigDir);
        chatOutput.write(formatAgentsList(agents));
        return actionResult(modelProviderSelection, coding.activeTurn);
    }

    if (command.kind === 'show') {
        const agents = await loadDiscoveredAgents(workspaceRoot, userConfigDir);
        const agent = agents.find((a) => a.name === command.name);
        if (agent === undefined) {
            chatOutput.write(`Agent not found: ${command.name}\n`);
            return actionResult(modelProviderSelection, coding.activeTurn);
        }
        chatOutput.write(formatAgentDetails(agent));
        return actionResult(modelProviderSelection, coding.activeTurn);
    }

    if (command.kind === 'reload') {
        bustSkillCache();
        const agents = await loadDiscoveredAgents(workspaceRoot, userConfigDir);
        chatOutput.write(`Reloaded ${agents.length} agent${agents.length === 1 ? '' : 's'}.\n`);
        await refreshAgentsDashboardIfOpen(coding, workspaceRoot, userConfigDir);
        return actionResult(modelProviderSelection, coding.activeTurn);
    }

    if (command.kind === 'disable') {
        const agents = await loadDiscoveredAgents(workspaceRoot, userConfigDir);
        if (!agents.some((a) => a.name === command.name)) {
            chatOutput.write(`Agent not found: ${command.name}\n`);
            return actionResult(modelProviderSelection, coding.activeTurn);
        }
        await toggleDisabled({ workspaceRoot }, command.name, 'add');
        chatOutput.write(`Disabled agent: ${command.name}\n`);
        await refreshAgentsDashboardIfOpen(coding, workspaceRoot, userConfigDir);
        return actionResult(modelProviderSelection, coding.activeTurn);
    }

    return assertNever(command);
}

async function runSkillsAction(
    chatOutput: ChatOutput,
    modelProviderSelection: ModelProviderSelection,
    coding: CodingActionContext,
    command: SkillsCommand,
): Promise<ChatActionResult> {
    if (coding.workspaceRoot === undefined) {
        chatOutput.write('Skills command unavailable: workspace root is unavailable\n');
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    if (command.kind === 'invalid') {
        chatOutput.write(`${command.message}\n`);
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    if (command.kind === 'reload') {
        const workspaceRoot = coding.workspaceRoot;
        const userConfigDir = resolveUserConfigDir();
        bustSkillCache();
        const { skills } = await discoverSkills({ workspaceRoot, userConfigDir });
        chatOutput.write(`Reloaded ${skills.length} skill${skills.length === 1 ? '' : 's'}.\n`);
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    return assertNever(command);
}

async function refreshAgentsDashboardIfOpen(
    coding: CodingActionContext,
    workspaceRoot: string,
    userConfigDir: string,
): Promise<void> {
    if (coding.reloadAgentsDashboard === undefined) return;
    const entries = await loadDashboardAgentEntries(workspaceRoot, userConfigDir);
    coding.reloadAgentsDashboard(entries);
}

export async function loadDiscoveredAgents(
    workspaceRoot: string,
    userConfigDir: string,
): Promise<readonly AgentDefinition[]> {
    const result = await discoverAgents({ workspaceRoot, userConfigDir });
    return new AgentIndex(result).list();
}

export async function loadDashboardAgentEntries(
    workspaceRoot: string,
    userConfigDir: string,
): Promise<DashboardAgentEntry[]> {
    const result = await discoverAgents({ workspaceRoot, userConfigDir });
    const agents = new AgentIndex(result).list();
    const disabled = await readDisabledSet({ workspaceRoot });
    const overrides = await readOverridesMap({ workspaceRoot });
    return agents.map((agent) => {
        const modelStr = formatDashboardModel(agent.model);
        const overrideStr = overrides.get(agent.name);
        const entry: DashboardAgentEntry = {
            name: agent.name,
            description: agent.description,
            source: agent.source,
            disabled: disabled.has(agent.name),
            ...(modelStr !== undefined ? { model: modelStr } : {}),
            ...(agent.tier !== undefined ? { tier: agent.tier } : {}),
            ...(overrideStr !== undefined ? { overrideModel: overrideStr } : {}),
            ...(agent.filePath !== undefined ? { filePath: agent.filePath } : {}),
        };
        return entry;
    });
}

function formatDashboardModel(model: AgentDefinition['model']): string | undefined {
    if (model === undefined) return undefined;
    if (typeof model === 'string') return model;
    return `${model.providerID}/${model.modelID}`;
}

async function runModelsAction(
    chatOutput: ChatOutput,
    modelProviderSelection: ModelProviderSelection,
    modelChoices: readonly ModelChoice[],
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    if (!coding.useTui || coding.openModelsOverlay === undefined) {
        chatOutput.write('/models requires the interactive TUI overlay.\n');
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    const entries = modelChoices.flatMap((choice) => {
        const variantSelections = createVariantChoices(choice.selection).map((v) => v.selection);
        return variantSelections.length > 0 ? variantSelections : [choice.selection];
    });
    if (entries.length === 0) {
        chatOutput.write('No models available. Configure a provider with /model first.\n');
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    const assignments = coding.authStore !== undefined ? await coding.authStore.getModelRoles() : {};
    const roleRows = createModelsOverlayRoleRows(assignments, modelProviderSelection);
    coding.openModelsOverlay(entries, roleRows);
    return actionResult(modelProviderSelection, coding.activeTurn);
}

async function runMissionAction(
    chatOutput: ChatOutput,
    modelProviderSelection: ModelProviderSelection,
    coding: CodingActionContext,
): Promise<ChatActionResult> {
    if (!coding.useTui || coding.openMissionPanel === undefined) {
        chatOutput.write('/mission requires the interactive TUI overlay.\n');
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    const rows = await loadMissionPanelRows(coding.workspaceRoot);
    coding.openMissionPanel(rows);
    return actionResult(modelProviderSelection, coding.activeTurn);
}

/**
 * Build {@link MissionPanelRow} entries for the Runs tab from persisted
 * `.omo/missions` + `.omo/runs` records. Returns an empty array when the
 * workspace has no `.omo` root (the panel renders its empty state).
 */
export async function loadMissionPanelRows(workspaceRoot: string | undefined): Promise<MissionPanelRow[]> {
    if (workspaceRoot === undefined) return [];
    let omoRoot: string;
    try {
        omoRoot = await resolveOmoRoot(workspaceRoot);
    } catch {
        return [];
    }
    const missions = [...(await listMissions(omoRoot))].sort(compareMissionPanelMissions);
    const rows: MissionPanelRow[] = [];
    for (const mission of missions) {
        const runs = [...(await listRunsForMission(omoRoot, mission.id))].sort(compareMissionPanelRuns);
        if (runs.length === 0) {
            rows.push({
                id: mission.id,
                label: mission.name,
                status: mission.status,
                ...(mission.workflowName !== undefined ? { detail: `workflow: ${mission.workflowName}` } : {}),
            });
            continue;
        }
        for (const run of runs) {
            rows.push({
                id: run.id,
                label: `${mission.name} #${run.attempt}`,
                status: run.status,
                ...(run.startedAt !== undefined ? { detail: `started ${run.startedAt}` } : {}),
            });
        }
    }
    return rows;
}

function compareMissionPanelMissions(left: Mission, right: Mission): number {
    return (
        compareText(left.createdAt, right.createdAt) ||
        compareText(left.name, right.name) ||
        compareText(left.id, right.id)
    );
}

function compareMissionPanelRuns(left: Run, right: Run): number {
    return (
        compareText(left.startedAt ?? '', right.startedAt ?? '') ||
        compareText(left.prompt ?? '', right.prompt ?? '') ||
        compareText(left.id, right.id)
    );
}

function compareText(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

async function runApprovalAction(
    chatOutput: ChatOutput,
    modelProviderSelection: ModelProviderSelection,
    requestedLevel: ApprovalLevel | undefined,
    activeTurn: ActiveCodingAgentTurn | undefined,
    currentLevel: ApprovalLevel | undefined,
    selectApprovalLevel?: (currentLevel?: ApprovalLevel) => Promise<ApprovalLevel | undefined>,
): Promise<ChatActionResult> {
    if (requestedLevel !== undefined) {
        activeTurn?.setApprovalLevel(requestedLevel);
        const meta = APPROVAL_LEVEL_META[requestedLevel];
        const applied = activeTurn !== undefined ? ' (applied to active run)' : '';
        chatOutput.write(`Approval level set to: ${requestedLevel}${applied}\n  ${meta.description}\n`);
        return actionResult(modelProviderSelection, activeTurn, { approvalLevel: requestedLevel });
    }
    if (selectApprovalLevel !== undefined) {
        const selected = await selectApprovalLevel(currentLevel);
        if (selected === undefined) {
            return actionResult(modelProviderSelection, activeTurn);
        }
        activeTurn?.setApprovalLevel(selected);
        const meta = APPROVAL_LEVEL_META[selected];
        const applied = activeTurn !== undefined ? ' (applied to active run)' : '';
        chatOutput.write(`Approval level set to: ${selected}${applied}\n  ${meta.description}\n`);
        return actionResult(modelProviderSelection, activeTurn, { approvalLevel: selected });
    }
    const level = currentLevel ?? 'safe';
    const meta = APPROVAL_LEVEL_META[level];
    chatOutput.write(`Approval level: ${level}\n  ${meta.description}\n`);
    return actionResult(modelProviderSelection, activeTurn);
}
