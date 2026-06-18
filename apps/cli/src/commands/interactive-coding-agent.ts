import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    createCodingAgentNodeRegistry,
    createGraphTurnRunner,
    type JsonlSessionEventStore,
    ProjectTrustStore,
    type ProviderAdapter,
    projectApprovalContinuationMessages,
    redactCredentialText,
    type SdkModelResolver,
    SessionRunOwner,
    type SessionRunOwnerReceipt,
    type ToolInvocationSettlement,
} from '@mission-control/core';
import type {
    AbgSignal,
    AgentEvent,
    AgentEventEnvelope,
    ModelProviderSelection,
    ToolCall,
} from '@mission-control/protocol';
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
    const approvals = createInteractiveApprovalBroker(options);
    const renderState: ProviderRenderState = { streamingText: false };
    const owner = await createInteractiveRunOwner(options, approvals, renderState);
    let settled = false;
    const done = runOwnedCodingAgentTurn(options, owner, renderState, action)
        .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            options.output.write(`Error: ${message}\n`);
        })
        .finally(() => {
            settled = true;
        });

    return {
        done,
        interrupt: () => {
            approvals.cancel('interrupted by user');
            interruptOwnerUntilSettled(owner, () => settled);
        },
        answerApproval: approvals.answer,
        hasPendingApproval: approvals.hasPending,
    };
}

async function createInteractiveRunOwner(
    options: Omit<CodingAgentTurnOptions, 'prompt'> & { readonly prompt?: string },
    approvals: ReturnType<typeof createInteractiveApprovalBroker>,
    renderState: ProviderRenderState,
): Promise<SessionRunOwner> {
    const toolOptions = {
        workspaceRoot: options.workspaceRoot,
        sessionId: options.sessionId,
        modelProviderSelection: options.modelProviderSelection,
        output: options.output,
        emitEvent: options.emitEvent,
        enableTrustedBash: await workspaceHasTrustedBash(options.workspaceRoot),
        ...(options.commandExecutor !== undefined ? { commandExecutor: options.commandExecutor } : {}),
    };
    const toolRegistry = await createInteractiveToolRegistry(toolOptions, approvals);

    // The graph engine is the only engine. Build the graph turn runner unconditionally; the owner
    // drives the ABG coding-agent graph through the SAME SessionRunOwner + toolRegistry the prior
    // flat loop used, so approval/blocking semantics are preserved.
    const resolveSdkModel = await resolveInteractiveSdkModel(options);
    const onSignal = interactiveGraphStreamSignal(options.output, renderState, options.workspaceRoot);
    const runProviderTurn = createGraphTurnRunner({
        graph: buildCodingAgentGraphForSelection(options.modelProviderSelection),
        sessionId: options.sessionId,
        now: () => new Date().toISOString(),
        modelProviderSelection: options.modelProviderSelection,
        registry: createCodingAgentNodeRegistry(),
        resolveSdkModel,
        toolRegistry,
        haltOnFailedToolSettlement: true,
        serializeToolExecution: true,
        onSignal,
    });

    // Graph events surface ONLY through onDurableEvent (no provider envelopes fire on the graph).
    // Render them to the TUI; observe for recording.
    const onDurableEventHandler = (event: AgentEvent) => {
        renderInteractiveGraphDurableEvent(options.output, renderState, event);
        options.observeStoredEvent?.(event);
    };

    return new SessionRunOwner({
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
        onProviderEnvelope: (envelope: AgentEventEnvelope) =>
            renderProviderEnvelope(options.output, renderState, envelope),
        onToolCall: (toolCall: ToolCall) => preflightInteractiveToolCall(toolCall, toolOptions, approvals),
        onToolSettlement: (settlement: ToolInvocationSettlement) =>
            renderInteractiveToolSettlement(options.output, settlement),
    });
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
    finalMessage?: string;
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
function interactiveGraphStreamSignal(
    output: ChatOutput,
    state: ProviderRenderState,
    workspaceRoot: string,
): (signal: AbgSignal) => Promise<void> {
    return async (signal) => {
        const delta = readDeltaFromSignal(signal);
        if (delta !== undefined) {
            if (!state.streamingText) {
                output.write('Assistant: ');
                state.streamingText = true;
            }
            output.write(delta);
            return;
        }
        const proposal = readToolCallProposal(signal);
        if (proposal !== undefined) {
            // A tool proposal ends the assistant text stream (the model emits no more text after
            // proposing tools within a single step); close it so the preview does not append to a
            // half-written assistant line, matching the flat path's non-streaming preview render.
            if (state.streamingText) {
                output.write('\n');
                state.streamingText = false;
            }
            await renderToolPreview(proposal, output, workspaceRoot);
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
        renderGraphToolSettlement(output, emit.payload, 'completed');
        return;
    }
    if (emit.type === 'tool.failed') {
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

/** Pull the `delta` string off an `llm.text.delta` emit signal; `undefined` for other signals. */
function readDeltaFromSignal(signal: AbgSignal): string | undefined {
    if (signal.type !== 'emit' || signal.event.type !== 'llm.text.delta') {
        return undefined;
    }
    return readStringField(signal.event.payload, 'delta');
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
