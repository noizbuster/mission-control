import type { PermissionSession } from '@mission-control/core';
import {
    type AskUserQuestionRequest,
    type CommandExecutionRequest,
    type CommandExecutionResult,
    createCodingAgentNodeRegistry,
    createGraphTurnRunner,
    type JsonlSessionEventStore,
    type LspClient,
    McpConnectionManager,
    type PricingTable,
    type ProjectInstructionResource,
    ProjectTrustStore,
    type ProviderAdapter,
    projectApprovalContinuationMessages,
    redactCredentialText,
    type SdkModelResolver,
    SessionRunOwner,
    type SessionRunOwnerReceipt,
    type SystemPromptEnvironment,
    type ToolInvocationSettlement,
} from '@mission-control/core';
import type {
    AbgGraphSpec,
    AbgSignal,
    AgentEvent,
    AgentEventEnvelope,
    ModelProviderSelection,
    ToolCall,
} from '@mission-control/protocol';
import type { AbgOverlayController } from './abg-overlay-controller.js';
import {
    type AbgOverlayState,
    projectAbgSignal,
    RECENT_EVENTS_CAP,
    type RecentEvent,
    type RunState,
    readRefreshMsFromEnv,
} from './abg-overlay-state.js';
import type { ApprovalLevel } from './approval-level.js';
import { buildCodingAgentSystemPromptEnv, loadTrustedProjectInstructionResources } from './coding-agent-context.js';
import { createInteractiveApprovalBroker } from './interactive-approval-broker.js';
import type { ChatOutput } from './interactive-chat-io.js';
import { parseFileWriteOutput } from './interactive-coding-file-write-preview.js';
import { parseFileEditOutput, parseFilePatchOutput, renderToolPreview } from './interactive-coding-tool-preview.js';
import { createInteractiveToolRegistry, preflightInteractiveToolCall } from './interactive-coding-tools.js';
import { buildCodingAgentGraphForSelection, resolveGraphSdkModel } from './run-agent-graph-prompt.js';

export type ActiveCodingAgentTurn = {
    readonly done: Promise<void>;
    readonly interrupt: (mode?: InterruptMode) => void;
    readonly answerApproval: (line: string) => boolean;
    readonly hasPendingApproval: () => boolean;
    readonly setApprovalLevel: (level: ApprovalLevel) => void;
};

export type InterruptMode = 'soft' | 'force';

export type CodingAgentTurnOptions = {
    readonly prompt: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly store: JsonlSessionEventStore;
    readonly provider: ProviderAdapter;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly workspaceRoot: string;
    readonly output: ChatOutput;
    readonly emitEvent: (event: AgentEvent) => void;
    readonly observeStoredEvent?: (event: AgentEvent) => void;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    /**
     * Execution engine for the turn. `'graph'` is the only supported value (the flat provider-turn
     * loop has been removed); retained on the options shape for caller compatibility. When set,
     * `resolveSdkModel` resolves the AI-SDK model (falling back to the flat→AI-SDK bridge over `provider`).
     */
    readonly engine?: 'graph';
    readonly resolveSdkModel?: SdkModelResolver;
    /**
     * LSP seam: inject a real `LspClient` to register the `lsp` tool for this turn. Default
     * undefined — the tool stays unadvertised (a real stdio transport is deferred).
     */
    readonly lspClient?: LspClient;
    /**
     * `ask_user` tool callback. When omitted, the `ask_user` tool is not registered for the turn
     * (no host surface to ask the user). The interactive TUI supplies the Ink question overlay.
     */
    readonly requestUserQuestion?: (request: AskUserQuestionRequest) => Promise<string>;
    /**
     * Optional ABG overlay controller (Wave 2). When present, its plane-A `observer` is composed
     * into the interactive graph signal tap (single-slot `onSignal`, Metis 1.1), its
     * `onDurableEvent` settles `runState` on run-terminal events, and `dispose()` is invoked when the
     * turn settles so the coalescing flush timer is cleared. Injected by the host (todo 3 bridge)
     * — NOT threaded through the InkChatBridge public surface (Metis 3.1).
     */
    readonly abgOverlayController?: AbgOverlayController;
    /** Operator-supplied pricing table; threaded to the graph so `CostLedger` emits `policy.budget.*`. */
    readonly pricingTable?: PricingTable;
    readonly approvalLevel?: ApprovalLevel;
    /**
     * Optional ABG graph override. When provided (e.g. from a `#workflow` invocation), the turn
     * runs THIS graph instead of the default coding-agent graph built from the model selection.
     * Falls back to `buildCodingAgentGraphForSelection` when omitted.
     */
    readonly graph?: AbgGraphSpec;
    readonly permissionSession?: PermissionSession;
};

export async function startCodingAgentTurn(options: CodingAgentTurnOptions): Promise<ActiveCodingAgentTurn> {
    return startOwnedCodingAgentTurn(options, {
        taskStartedMessage: `user prompt: ${options.prompt}`,
        execute: (owner) =>
            owner.submit({
                prompt: options.prompt,
                inputId: `input_${options.turnId}`,
                messageId: `message_${options.turnId}`,
            }),
    });
}

export async function resumeCodingAgentTurn(
    options: Omit<CodingAgentTurnOptions, 'prompt'>,
): Promise<ActiveCodingAgentTurn> {
    return startOwnedCodingAgentTurn(options, {
        taskStartedMessage: 'resume blocked run',
        execute: (owner) => owner.resume(),
    });
}

async function startOwnedCodingAgentTurn(
    options: Omit<CodingAgentTurnOptions, 'prompt'> & { readonly prompt?: string },
    action: {
        readonly taskStartedMessage: string;
        readonly execute: (owner: SessionRunOwner) => Promise<SessionRunOwnerReceipt>;
    },
): Promise<ActiveCodingAgentTurn> {
    const approvals = createInteractiveApprovalBroker(options, options.permissionSession);
    const renderState: ProviderRenderState = {
        streamingText: false,
        streamingThinking: false,
        toolCount: 0,
        toolNames: [],
    };
    const { owner, mcpConnectionManager, overlayWiring } = await createInteractiveRunOwner(
        options,
        approvals,
        renderState,
    );
    let settled = false;
    const done = runOwnedCodingAgentTurn(options, owner, renderState, action)
        .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            options.output.write(`Error: ${message}\n`);
        })
        .finally(() => {
            settled = true;
            void mcpConnectionManager.disconnectAll();
            overlayWiring?.dispose();
        });

    return {
        done,
        interrupt: () => {
            approvals.cancel('interrupted by user');
            interruptOwnerUntilSettled(owner, () => settled);
        },
        answerApproval: approvals.answer,
        hasPendingApproval: approvals.hasPending,
        setApprovalLevel: approvals.setApprovalLevel,
    };
}

async function createInteractiveRunOwner(
    options: Omit<CodingAgentTurnOptions, 'prompt'> & { readonly prompt?: string },
    approvals: ReturnType<typeof createInteractiveApprovalBroker>,
    renderState: ProviderRenderState,
): Promise<{
    readonly owner: SessionRunOwner;
    readonly mcpConnectionManager: McpConnectionManager;
    readonly overlayWiring: AbgOverlayWiring | undefined;
}> {
    // Resolve the SDK model BEFORE building the tool registry so the `task` subagent tool can
    // capture it in its spawn closure (the child graph needs the same model resolver as the parent).
    const resolveSdkModel = await resolveInteractiveSdkModel(options);
    const toolOptions = {
        workspaceRoot: options.workspaceRoot,
        sessionId: options.sessionId,
        modelProviderSelection: options.modelProviderSelection,
        output: options.output,
        emitEvent: options.emitEvent,
        resolveSdkModel,
        enableTrustedBash: await workspaceHasTrustedBash(options.workspaceRoot),
        ...(options.commandExecutor !== undefined ? { commandExecutor: options.commandExecutor } : {}),
        ...(options.lspClient !== undefined ? { lspClient: options.lspClient } : {}),
        ...(options.requestUserQuestion !== undefined ? { requestUserQuestion: options.requestUserQuestion } : {}),
    };
    const { registry: toolRegistry, mcpConnectionManager } = await createInteractiveToolRegistry(
        toolOptions,
        approvals,
    );

    // The graph engine is the only engine. Build the graph turn runner unconditionally; the owner
    // drives the ABG coding-agent graph through the SAME SessionRunOwner + toolRegistry the prior
    // flat loop used, so approval/blocking semantics are preserved.
    const graphSpec = options.graph ?? buildCodingAgentGraphForSelection(options.modelProviderSelection);
    const overlayWiring =
        options.abgOverlayController !== undefined
            ? wireAbgOverlay(options.abgOverlayController, graphSpec)
            : undefined;
    const extraObservers: ReadonlyArray<(signal: AbgSignal) => void> =
        overlayWiring !== undefined ? [overlayWiring.observer] : [];
    const onSignal = interactiveGraphStreamSignal(options.output, renderState, options.workspaceRoot, extraObservers);
    // System-prompt context: the model needs to know WHERE it is (cwd/workspace/git) and what
    // project-local instructions (AGENTS.md/CLAUDE.md) apply, otherwise it answers generically.
    // Built per turn — date is fresh, AGENTS.md may have changed since the prior turn.
    const systemPromptEnv = await buildCodingAgentSystemPromptEnv({
        workspaceRoot: options.workspaceRoot,
        modelId: options.modelProviderSelection.modelID,
    });
    const projectInstructionResources = await loadTrustedProjectInstructionResources(options.workspaceRoot);
    const runProviderTurn = createGraphTurnRunner({
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
        ...(projectInstructionResources.length > 0 ? { projectInstructionResources } : {}),
        ...(options.pricingTable !== undefined ? { pricingTable: options.pricingTable } : {}),
    });

    // Graph events surface ONLY through onDurableEvent (no provider envelopes fire on the graph).
    // Render them to the TUI; observe for recording; settle the overlay's runState on run-terminal events.
    const onDurableEventHandler = (event: AgentEvent) => {
        renderInteractiveGraphDurableEvent(options.output, renderState, event);
        options.observeStoredEvent?.(event);
        overlayWiring?.onDurableEvent(event);
    };

    const owner = new SessionRunOwner({
        sessionId: options.sessionId,
        store: options.store,
        provider: options.provider,
        modelProviderSelection: options.modelProviderSelection,
        projectContext: { workspaceRoot: options.workspaceRoot },
        readMessages: async () =>
            projectApprovalContinuationMessages(await options.store.getEvents(options.sessionId), options.sessionId),
        toolRegistry,
        runProviderTurn,
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
    });

    return { owner, mcpConnectionManager, overlayWiring };
}

async function workspaceHasTrustedBash(workspaceRoot: string): Promise<boolean> {
    const trust = await new ProjectTrustStore().getDecision(workspaceRoot);
    return trust.decision === 'trusted';
}

function interruptOwnerUntilSettled(owner: SessionRunOwner, isSettled: () => boolean): void {
    const interrupt = () => {
        if (!isSettled()) {
            void owner.interrupt('interrupted by user');
        }
    };
    interrupt();
    for (const delayMs of [0, 5, 25]) {
        setTimeout(interrupt, delayMs);
    }
}

async function runOwnedCodingAgentTurn(
    options: Omit<CodingAgentTurnOptions, 'prompt'> & { readonly prompt?: string },
    owner: SessionRunOwner,
    renderState: ProviderRenderState,
    action: {
        readonly taskStartedMessage: string;
        readonly execute: (owner: SessionRunOwner) => Promise<SessionRunOwnerReceipt>;
    },
): Promise<void> {
    emitTaskEvent(options, 'task.started', action.taskStartedMessage);
    const receipt = await action.execute(owner);
    settleReceipt(options, receipt, renderState);
}

function settleReceipt(
    options: Omit<CodingAgentTurnOptions, 'prompt'> & { readonly prompt?: string },
    receipt: SessionRunOwnerReceipt,
    renderState: ProviderRenderState,
): void {
    switch (receipt.status) {
        case 'completed':
            emitTaskEvent(options, 'task.completed', renderState.finalMessage ?? 'run completed');
            return;
        case 'interrupted':
            options.output.write('Interrupted active run\n');
            emitTaskEvent(options, 'task.failed', 'provider turn interrupted');
            return;
        case 'blocked_on_approval':
            options.output.write(formatBlockedRunMessage(receipt.reason ?? 'approval required', receipt.toolCallId));
            return;
        case 'failed':
            options.output.write(`Error: ${redactCredentialText(receipt.reason ?? 'run failed')}\n`);
            emitTaskEvent(options, 'task.failed', receipt.reason ?? 'run failed');
            return;
        case 'idle':
        case 'running':
        case 'queued':
            return;
        default:
            assertNeverReceipt(receipt.status);
    }
}

type ProviderRenderState = {
    streamingText: boolean;
    streamingThinking: boolean;
    finalMessage?: string;
    toolCount: number;
    toolNames: string[];
};

function renderProviderEnvelope(output: ChatOutput, state: ProviderRenderState, envelope: AgentEventEnvelope): void {
    const chunk = envelope.event.providerStreamChunk;
    if (chunk?.kind === 'text_delta') {
        if (!state.streamingText) {
            output.write('Assistant: ');
            state.streamingText = true;
        }
        output.write(chunk.delta);
        return;
    }
    if (chunk?.kind !== 'response_completed') {
        return;
    }
    if (state.streamingText) {
        output.write('\n');
        state.streamingText = false;
    } else if (chunk.finishReason !== 'tool_calls') {
        output.write(`Assistant: ${chunk.message.content}\n`);
    }
    if (chunk.finishReason !== 'tool_calls') {
        state.finalMessage = chunk.message.content;
    }
}

function renderInteractiveToolSettlement(output: ChatOutput, settlement: ToolInvocationSettlement): void {
    if (output.isToolOutputExpanded?.() === false) {
        return;
    }
    if (settlement.result.status === 'failed') {
        output.write(`${settlement.toolName} failed: ${settlement.result.error?.message ?? 'unknown error'}\n`);
        return;
    }
    if (settlement.toolName === 'file.patch') {
        const parsed = parseFilePatchOutput(settlement.structuredOutput);
        if (parsed !== undefined) {
            output.write(`Applied patch: ${parsed.appliedFiles.join(', ')}\n`);
        }
        return;
    }
    if (settlement.toolName === 'file.edit') {
        const parsed = parseFileEditOutput(settlement.structuredOutput);
        if (parsed !== undefined) {
            const noun = parsed.occurrencesReplaced === 1 ? 'occurrence' : 'occurrences';
            output.write(`Applied edit: ${parsed.appliedFiles.join(', ')} (${parsed.occurrencesReplaced} ${noun})\n`);
        }
        return;
    }
    if (settlement.toolName === 'file.write') {
        const parsed = parseFileWriteOutput(settlement.structuredOutput);
        if (parsed !== undefined) {
            const verb = parsed.operation === 'created' ? 'Created' : 'Replaced';
            output.write(`${verb} file: ${parsed.appliedFiles.join(', ')}\n`);
        }
        return;
    }
    if (settlement.toolName === 'command.run' || settlement.toolName === 'bash.run') {
        if (parseCommandRunStatus(settlement.structuredOutput) === 'failed') {
            output.write(`${settlement.toolName} failed: command_failed\n`);
            return;
        }
        output.write(`Command output for ${settlement.toolName}\n${settlement.modelOutput?.content ?? ''}\n`);
    }
}

/**
 * Resolve the AI-SDK model for an interactive graph turn. The interactive path always carries a
 * `provider` (the deterministic or real flat provider), so `resolveGraphSdkModel` short-circuits to the
 * flat→AI-SDK bridge — driving that provider on the graph with no auth-store resolution. An injected
 * `resolveSdkModel` (tests) wins.
 */
async function resolveInteractiveSdkModel(
    options: Omit<CodingAgentTurnOptions, 'prompt'> & { readonly prompt?: string },
): Promise<SdkModelResolver> {
    return resolveGraphSdkModel({
        selection: options.modelProviderSelection,
        ...(options.resolveSdkModel !== undefined ? { resolveSdkModel: options.resolveSdkModel } : {}),
        provider: options.provider,
    });
}

/**
 * Live signal tap for the interactive graph path. Renders `llm.text.delta` signals to the chat output
 * as they are yielded (before projection), so the TUI streams token-by-token — parity with the flat
 * path's `text_delta` envelope rendering. Also renders a tool-arg PREVIEW for each
 * `llm.tool_call.proposed` signal — the graph equivalent of the flat path's `onToolCall` →
 * `preflightInteractiveToolCall` → `renderToolPreview`, so a user approving a tool on the default
 * (graph) engine sees the same patch/command/edit preview they would on the flat escape hatch. The tap
 * is awaited between signals (see `AbgGraphRunnerInput.onSignal`), so an async preview (file.write
 * reads the target file) fully renders before the next signal — no fire-and-forget interleaving. Other
 * signals are ignored. The tap does not affect projection or persistence; `llm.turn.completed`
 * (rendered via `renderInteractiveGraphDurableEvent`) closes the stream with a newline and records the
 * final message.
 */
export function interactiveGraphStreamSignal(
    output: ChatOutput,
    state: ProviderRenderState,
    workspaceRoot: string,
    extraObservers: ReadonlyArray<(signal: AbgSignal) => void> = [],
): (signal: AbgSignal) => Promise<void> {
    return async (signal) => {
        try {
            if (signal.type === 'started') {
                if (state.streamingText) {
                    output.write('\n');
                    state.streamingText = false;
                }
                if (state.streamingThinking) {
                    output.write('\n');
                    state.streamingThinking = false;
                }
                output.write(`▸ ${signal.nodeId}\n`);
                return;
            }
            if (signal.type === 'failure') {
                const errorMsg = extractSignalError(signal.error);
                output.clearAgentStatus?.();
                if (state.streamingText || state.streamingThinking) {
                    output.write('\n');
                    state.streamingText = false;
                    state.streamingThinking = false;
                }
                output.write(`✗ ${signal.nodeId}: ${errorMsg}\n`);
                return;
            }
            if (signal.type === 'emit' && signal.event.type === 'llm.turn.started') {
                output.setAgentStatus?.('Thinking...');
                return;
            }
            if (signal.type === 'emit' && signal.event.type === 'llm.reasoning.delta') {
                if (output.isShowThinking?.() !== false) {
                    const reasoningDelta = readReasoningDeltaFromSignal(signal);
                    if (reasoningDelta !== undefined) {
                        if (!state.streamingThinking) {
                            if (state.streamingText) {
                                output.write('\n');
                                state.streamingText = false;
                            }
                            output.write('Thinking: ');
                            state.streamingThinking = true;
                        }
                        output.write(reasoningDelta);
                    } else {
                        output.setAgentStatus?.('Thinking...');
                    }
                }
                return;
            }
            const delta = readDeltaFromSignal(signal);
            if (delta !== undefined) {
                output.clearAgentStatus?.();
                if (state.streamingThinking) {
                    output.write('\n');
                    state.streamingThinking = false;
                }
                if (!state.streamingText) {
                    output.write('Assistant: ');
                    state.streamingText = true;
                }
                output.write(delta);
                return;
            }
            if (signal.type === 'emit' && signal.event.type === 'tool.started') {
                const toolName = readStringField(signal.event.payload, 'toolName') ?? 'tool';
                output.setAgentStatus?.(`Running ${toolName}...`);
                return;
            }
            const proposal = readToolCallProposal(signal);
            if (proposal !== undefined) {
                output.setAgentStatus?.(`Calling ${proposal.toolName}...`);
                if (state.streamingText) {
                    output.write('\n');
                    state.streamingText = false;
                }
                await renderToolPreview(proposal, output, workspaceRoot);
            }
        } finally {
            // Observers MUST stay sync `(signal) => void`: an async wrap adds a microtask hop per signal
            // and breaks the 33ms coalescing guarantee. Non-throwing (Metis 4.1): errors logged +
            // swallowed so a faulty observer cannot reject the awaited onSignal tap. Runs in `finally`
            // so early returns in the render body above never skip the fan-out.
            for (const observer of extraObservers) {
                try {
                    observer(signal);
                } catch (err) {
                    process.stderr.write(`[abg-overlay] observer error: ${String(err)}\n`);
                }
            }
        }
    };
}

/**
 * Render a graph AgentEvent (surfaced through `onDurableEvent`) to the interactive TUI. Maps the graph's
 * boundary emits to the same output the flat path produces: final assistant text (`llm.turn.completed`),
 * tool outcomes (`tool.completed`/`tool.failed`), and errors (`llm.error`). Tool settlements render here
 * because the coordinator's `onToolSettlement` hook does NOT fire for graph tool calls (graph tools run
 * through the registry directly), so the flat `renderInteractiveToolSettlement` would never be reached.
 */
function renderInteractiveGraphDurableEvent(output: ChatOutput, state: ProviderRenderState, event: AgentEvent): void {
    const emit = event.abg?.emit;
    if (emit === undefined) {
        return;
    }
    if (emit.type === 'llm.turn.completed') {
        output.clearAgentStatus?.();
        if (state.streamingThinking) {
            output.write('\n');
            state.streamingThinking = false;
        }
        if (state.toolCount > 0) {
            const noun = state.toolCount === 1 ? 'tool' : 'tools';
            const summary = formatToolCountSummary(state.toolNames);
            output.write(`\u2713 ${state.toolCount} ${noun} (${summary})\n`);
            state.toolCount = 0;
            state.toolNames = [];
        }
        const text = readStringField(emit.payload, 'text') ?? '';
        if (state.streamingText) {
            output.write('\n');
            state.streamingText = false;
        } else if (text.length > 0) {
            output.write(`Assistant: ${text}\n`);
        }
        if (text.length > 0) {
            state.finalMessage = text;
        }
        return;
    }
    if (emit.type === 'tool.completed') {
        state.toolCount += 1;
        const name = readStringField(emit.payload, 'toolName') ?? 'tool';
        state.toolNames = [...state.toolNames, name];
        output.clearAgentStatus?.();
        renderGraphToolSettlement(output, emit.payload, 'completed');
        return;
    }
    if (emit.type === 'tool.failed') {
        state.toolCount += 1;
        const name = readStringField(emit.payload, 'toolName') ?? 'tool';
        state.toolNames = [...state.toolNames, name];
        output.clearAgentStatus?.();
        renderGraphToolSettlement(output, emit.payload, 'failed');
        return;
    }
    if (emit.type === 'llm.error') {
        const message = readStringField(emit.payload, 'error');
        output.write(`Error: ${redactCredentialText(message ?? 'LLM error')}\n`);
    }
}

/**
 * Render a graph tool outcome from its emit payload. Mirrors the flat `renderInteractiveToolSettlement`
 * shape, reading fields off the `unknown` payload with `in`/`typeof` narrowing (no casts). The graph
 * `output` is the model-facing settlement string (a stableJson of the structured object for file tools,
 * or the command stdout for command tools) — re-parsed to recover the detail the flat path renders.
 */
function renderGraphToolSettlement(output: ChatOutput, payload: unknown, status: 'completed' | 'failed'): void {
    const toolName = readStringField(payload, 'toolName') ?? 'tool';
    if (output.isToolOutputExpanded?.() === false) {
        return;
    }
    if (status === 'failed') {
        const message = readErrorMessage(payload);
        output.write(`${toolName} failed: ${redactCredentialText(message ?? 'unknown error')}\n`);
        return;
    }
    const modelOutput = readStringField(payload, 'output');
    // Prefer the structured output object the adapter carries on the emit (parity with the flat
    // path's `settlement.structuredOutput`); fall back to parsing the model-facing `output` string
    // for emits/older sessions that carry only that.
    const structured = readStructuredOutputField(payload) ?? tryParseStructuredOutput(modelOutput);
    if (toolName === 'file.patch') {
        const parsed = structured !== undefined ? parseFilePatchOutput(structured) : undefined;
        if (parsed !== undefined) {
            output.write(`Applied patch: ${parsed.appliedFiles.join(', ')}\n`);
        }
        return;
    }
    if (toolName === 'file.edit') {
        const parsed = structured !== undefined ? parseFileEditOutput(structured) : undefined;
        if (parsed !== undefined) {
            const noun = parsed.occurrencesReplaced === 1 ? 'occurrence' : 'occurrences';
            output.write(`Applied edit: ${parsed.appliedFiles.join(', ')} (${parsed.occurrencesReplaced} ${noun})\n`);
        }
        return;
    }
    if (toolName === 'file.write') {
        const parsed = structured !== undefined ? parseFileWriteOutput(structured) : undefined;
        if (parsed !== undefined) {
            const verb = parsed.operation === 'created' ? 'Created' : 'Replaced';
            output.write(`${verb} file: ${parsed.appliedFiles.join(', ')}\n`);
        }
        return;
    }
    if (toolName === 'command.run' || toolName === 'bash.run') {
        output.write(`Command output for ${toolName}\n${modelOutput ?? ''}\n`);
    }
}

const TOOL_SUMMARY_MAX_ENTRIES = 5;

export function formatToolCountSummary(names: readonly string[]): string {
    const counts = new Map<string, number>();
    const order: string[] = [];
    for (const name of names) {
        const current = counts.get(name);
        if (current === undefined) {
            counts.set(name, 1);
            order.push(name);
        } else {
            counts.set(name, current + 1);
        }
    }
    const entries = order.map((name) => {
        const count = counts.get(name) ?? 1;
        return count === 1 ? name : `${name} \u00d7${count}`;
    });
    if (entries.length <= TOOL_SUMMARY_MAX_ENTRIES) {
        return entries.join(', ');
    }
    const shown = entries.slice(0, TOOL_SUMMARY_MAX_ENTRIES).join(', ');
    return `${shown}, +${entries.length - TOOL_SUMMARY_MAX_ENTRIES} more`;
}

/** Pull the `delta` string off an `llm.text.delta` emit signal; `undefined` for other signals. */
function readDeltaFromSignal(signal: AbgSignal): string | undefined {
    if (signal.type !== 'emit' || signal.event.type !== 'llm.text.delta') {
        return undefined;
    }
    return readStringField(signal.event.payload, 'delta');
}

function readReasoningDeltaFromSignal(signal: AbgSignal): string | undefined {
    if (signal.type !== 'emit' || signal.event.type !== 'llm.reasoning.delta') {
        return undefined;
    }
    return readStringField(signal.event.payload, 'delta');
}

function extractSignalError(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'message' in error) {
        const msg = (error as { message: unknown }).message;
        return typeof msg === 'string' ? msg : String(msg);
    }
    return typeof error === 'string' ? error : String(error ?? 'unknown error');
}

/**
 * Read a `ToolCall` off an `llm.tool_call.proposed` emit signal (the graph's tool-proposal boundary),
 * re-serializing the parsed `input` object into the `argumentsJson` string `renderToolPreview` expects
 * (the flat path's `ToolCall` carries the serialized form; the graph adapter carries the parsed object
 * at `payload.input`). `undefined` for non-proposal signals or payloads missing a string
 * `toolCallId`/`toolName` or a non-object `input`. Narrowed with `in`/`typeof` — no cast.
 */
function readToolCallProposal(signal: AbgSignal): ToolCall | undefined {
    if (signal.type !== 'emit' || signal.event.type !== 'llm.tool_call.proposed') {
        return undefined;
    }
    const payload = signal.event.payload;
    if (!isPlainObject(payload)) {
        return undefined;
    }
    const toolCallId = payload['toolCallId'];
    const toolName = payload['toolName'];
    const input = payload['input'];
    if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
        return undefined;
    }
    if (typeof toolName !== 'string' || toolName.length === 0) {
        return undefined;
    }
    if (input === null || typeof input !== 'object') {
        return undefined;
    }
    return { toolCallId, toolName, argumentsJson: JSON.stringify(input) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(payload: unknown, field: string): string | undefined {
    if (!isPlainObject(payload)) {
        return undefined;
    }
    const value = payload[field];
    return typeof value === 'string' ? value : undefined;
}

/** Read a human-readable message off an emit payload's `error` field (string or `{ message }`). */
function readErrorMessage(payload: unknown): string | undefined {
    if (!isPlainObject(payload)) {
        return undefined;
    }
    const error = payload['error'];
    if (typeof error === 'string') {
        return error;
    }
    return readStringField(error, 'message');
}

/**
 * Recover the structured tool output object the flat path renders. File tools emit the model-facing
 * `output` as a stableJson of their structured object, so `JSON.parse` recovers it; non-JSON outputs
 * (command stdout, truncated payloads) yield `undefined` and render as their raw string instead.
 */
function tryParseStructuredOutput(modelOutput: string | undefined): unknown {
    if (modelOutput === undefined) {
        return undefined;
    }
    try {
        return JSON.parse(modelOutput);
    } catch {
        return undefined;
    }
}

/**
 * Read the structured output object the adapter carries on a `tool.completed` emit
 * (`payload.structuredOutput`) — the graph-side equivalent of the flat path's
 * `settlement.structuredOutput`. `undefined` when the payload omits it or carries a non-object.
 */
function readStructuredOutputField(payload: unknown): unknown {
    if (!isPlainObject(payload)) {
        return undefined;
    }
    const value = payload['structuredOutput'];
    return isPlainObject(value) ? value : undefined;
}

function parseCommandRunStatus(value: unknown): 'completed' | 'failed' | undefined {
    if (!isRecord(value) || value.kind !== 'command_run') {
        return undefined;
    }
    return value.status === 'completed' || value.status === 'failed' ? value.status : undefined;
}

function emitTaskEvent(
    options: Omit<CodingAgentTurnOptions, 'prompt'> & { readonly prompt?: string },
    type: 'task.started' | 'task.completed' | 'task.failed',
    message: string,
): void {
    options.emitEvent({
        type,
        timestamp: new Date().toISOString(),
        sessionId: options.sessionId,
        taskId: options.turnId,
        message,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: options.modelProviderSelection,
    });
}

function formatBlockedRunMessage(reason: string, toolCallId?: string): string {
    const details = toolCallId === undefined ? '' : ` Pending tool call: ${toolCallId}.`;
    return `Run blocked (resumable): ${reason}. Resume with /resume.${details}\n`;
}

function assertNeverReceipt(value: never): never {
    throw new Error(`Unexpected run owner receipt status: ${String(value)}`);
}

function isRecord(value: unknown): value is { readonly kind?: unknown; readonly status?: unknown } {
    return typeof value === 'object' && value !== null;
}

export type AbgOverlayWiring = {
    readonly observer: (signal: AbgSignal) => void;
    readonly onDurableEvent: (event: AgentEvent) => void;
    readonly onProviderEnvelope?: (envelope: AgentEventEnvelope) => void;
    readonly onToolCall?: (toolCall: ToolCall) => void;
    readonly onToolSettlement?: (settlement: ToolInvocationSettlement) => void;
    readonly dispose: () => void;
};

function runSettleState(eventType: string): RunState | undefined {
    switch (eventType) {
        case 'run.completed':
            return 'completed';
        case 'run.interrupted':
            return 'interrupted';
        case 'run.failed':
            return 'failed';
        case 'run.blocked':
            return 'blocked_on_approval';
        default:
            return undefined;
    }
}

function applyProviderEnvelopeToPatch(state: AbgOverlayState, envelope: AgentEventEnvelope): Partial<AbgOverlayState> {
    const event = envelope.event;
    const chunk = event.providerStreamChunk;
    if (chunk === undefined) return {};
    if (chunk.kind === 'text_delta' && typeof chunk.delta === 'string') {
        return { lastLiveDelta: redactCredentialText(chunk.delta, []) };
    }
    if (chunk.kind === 'response_completed' && chunk.usage !== undefined) {
        return {
            inputTokens: state.inputTokens + chunk.usage.inputTokens,
            outputTokens: state.outputTokens + chunk.usage.outputTokens,
            modelCalls: state.modelCalls + 1,
        };
    }
    return {};
}

function applyToolCallToPatch(toolCall: ToolCall): Partial<AbgOverlayState> {
    const event: RecentEvent = {
        timestamp: '',
        type: 'tool.started',
        message: redactCredentialText(`tool call: ${toolCall.toolName}`, []),
    };
    return { recentEvents: [event] };
}

export function wireAbgOverlay(controller: AbgOverlayController, graphSpec?: AbgGraphSpec): AbgOverlayWiring {
    const store = controller.store;
    let pendingSnapshot: AbgOverlayState = store.getSnapshot();
    let pending: Partial<AbgOverlayState> = {};
    let dirty = false;
    const refreshMs = readRefreshMsFromEnv();

    const commitToStore = (): void => {
        if (!dirty) return;
        const patch = pending;
        pending = {};
        dirty = false;
        store.update((draft) => {
            Object.assign(draft, patch);
        });
        pendingSnapshot = store.getSnapshot();
    };

    const timer = setInterval(commitToStore, refreshMs);

    // Seed the store at construction time so the overlay shows the graph structure before
    // graph.started fires (closes the async setup timing gap). Idempotent with graph.started.
    if (graphSpec !== undefined) {
        const seedNodes = new Map(pendingSnapshot.nodes);
        for (const node of graphSpec.nodes) {
            if (!seedNodes.has(node.id)) {
                seedNodes.set(node.id, 'idle');
            }
        }
        const seedEdges = graphSpec.edges.map((edge) => ({
            source: edge.source,
            target: edge.target,
            ...(edge.condition !== undefined ? { condition: edge.condition } : {}),
        }));
        pending = {
            ...pending,
            activeGraphId: graphSpec.id,
            graphStatus: 'active',
            nodes: seedNodes,
            graphEdges: seedEdges,
        };
        pendingSnapshot = { ...pendingSnapshot, ...pending };
        dirty = true;
        commitToStore();
    }

    const observer = (signal: AbgSignal): void => {
        const patch = projectAbgSignal(pendingSnapshot, signal);
        pendingSnapshot = { ...pendingSnapshot, ...patch };
        pending = { ...pending, ...patch };
        dirty = true;
        commitToStore();
    };

    const onDurableEvent = (event: AgentEvent): void => {
        const abg = event.abg;
        if (abg !== undefined) {
            if (abg.graphId !== undefined && event.type === 'graph.started') {
                const nodes = new Map(pendingSnapshot.nodes);
                if (graphSpec !== undefined) {
                    for (const node of graphSpec.nodes) {
                        if (!nodes.has(node.id)) {
                            nodes.set(node.id, 'idle');
                        }
                    }
                }
                pending = { ...pending, activeGraphId: abg.graphId, graphStatus: 'active', nodes };
                pendingSnapshot = { ...pendingSnapshot, ...pending };
                dirty = true;
            }
            if (abg.graphId !== undefined && event.type === 'graph.completed') {
                pending = { ...pending, graphStatus: 'completed' };
                pendingSnapshot = { ...pendingSnapshot, ...pending };
                dirty = true;
            }
            if (abg.graphId !== undefined && event.type === 'graph.failed') {
                pending = { ...pending, graphStatus: 'failed' };
                pendingSnapshot = { ...pendingSnapshot, ...pending };
                dirty = true;
            }
            if (abg.nodeId !== undefined) {
                const nodes = new Map(pendingSnapshot.nodes);
                if (event.type === 'node.started') {
                    nodes.set(abg.nodeId, 'running');
                } else if (event.type === 'node.completed') {
                    nodes.set(abg.nodeId, 'succeeded');
                } else if (event.type === 'node.failed') {
                    nodes.set(abg.nodeId, 'failed');
                }
                pending = { ...pending, nodes };
                pendingSnapshot = { ...pendingSnapshot, nodes };
                dirty = true;
            }
        }
        commitToStore();
        const settleState = runSettleState(event.type);
        if (settleState === undefined) return;
        let pendingApprovalsPatch:
            | readonly {
                  approvalId: string;
                  requestId: string;
                  policyDecision: 'prompt';
                  state: 'pending';
                  subject: { kind: 'tool'; id: string };
                  requestedAt: string;
                  reason?: string;
              }[]
            | undefined;
        if (event.type === 'run.blocked') {
            const evt = event as {
                toolCallId?: string;
                approvalId?: string;
                run?: { toolCallId?: string; reason?: string };
            };
            const toolCallId = evt.toolCallId ?? evt.run?.toolCallId;
            const reason = evt.run?.reason ?? event.message;
            if (toolCallId !== undefined) {
                pendingApprovalsPatch = [
                    {
                        approvalId: evt.approvalId ?? toolCallId,
                        requestId: toolCallId,
                        policyDecision: 'prompt',
                        state: 'pending',
                        subject: { kind: 'tool', id: toolCallId },
                        requestedAt: event.timestamp,
                        ...(reason !== undefined ? { reason } : {}),
                    },
                ];
            }
        } else if (settleState === 'running' || settleState === 'completed' || settleState === 'failed') {
            pendingApprovalsPatch = [];
        }
        store.update((draft) => {
            Object.assign(draft, {
                runState: settleState,
                lastSettledAt: event.timestamp,
                ...(event.type === 'run.interrupted' ? { graphStatus: 'cancelled' } : {}),
                ...(pendingApprovalsPatch !== undefined ? { pendingApprovals: pendingApprovalsPatch } : {}),
            });
        });
    };

    const onProviderEnvelope = (envelope: AgentEventEnvelope): void => {
        const patch = applyProviderEnvelopeToPatch(pendingSnapshot, envelope);
        if (Object.keys(patch).length === 0) return;
        pendingSnapshot = { ...pendingSnapshot, ...patch };
        pending = { ...pending, ...patch };
        dirty = true;
    };

    const onToolCall = (toolCall: ToolCall): void => {
        const patch = applyToolCallToPatch(toolCall);
        pendingSnapshot = { ...pendingSnapshot, ...patch };
        pending = { ...pending, ...patch };
        dirty = true;
    };

    const onToolSettlement = (settlement: ToolInvocationSettlement): void => {
        const event: RecentEvent = {
            timestamp: '',
            type: settlement.result.status === 'completed' ? 'tool.completed' : 'tool.failed',
            message: redactCredentialText(`tool ${settlement.toolName}: ${settlement.result.status}`, []),
        };
        pendingSnapshot = {
            ...pendingSnapshot,
            recentEvents: [...pendingSnapshot.recentEvents, event].slice(-RECENT_EVENTS_CAP),
        };
        pending = {
            ...pending,
            recentEvents: [...(pending.recentEvents ?? []), event],
        };
        dirty = true;
    };

    const dispose = (): void => {
        clearInterval(timer);
        commitToStore();
    };

    return { observer, onDurableEvent, onProviderEnvelope, onToolCall, onToolSettlement, dispose };
}
