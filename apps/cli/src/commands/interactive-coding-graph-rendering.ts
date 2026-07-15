import { redactCredentialText, type ToolInvocationSettlement } from '@mission-control/core';
import type { AbgSignal, AgentEvent } from '@mission-control/protocol';
import type { ChatOutput } from './interactive-chat-io';
import { parseFileWriteOutput } from './interactive-coding-file-write-preview';
import {
    extractSignalError,
    formatToolCountSummary,
    readDeltaFromSignal,
    readErrorMessage,
    readReasoningDeltaFromSignal,
    readStringField,
    readToolCallProposal,
    structuredToolOutput,
} from './interactive-coding-signal-payload';
import { parseFileEditOutput, parseFilePatchOutput, renderToolPreview } from './interactive-coding-tool-preview';
import {
    type InteractiveGraphSignalObserver,
    notifyInteractiveGraphSignalObservers,
} from './interactive-graph-signal-observers';

export type ProviderRenderState = {
    streamingText: boolean;
    streamingThinking: boolean;
    finalMessage?: string;
    toolCount: number;
    toolNames: string[];
};

export function interactiveGraphStreamSignal(
    output: ChatOutput,
    state: ProviderRenderState,
    workspaceRoot: string,
    extraObservers: readonly InteractiveGraphSignalObserver[] = [],
): (signal: AbgSignal) => Promise<void> {
    return async (signal) => {
        let renderError: unknown;
        try {
            const renderResult = renderInteractiveGraphSignal(output, state, workspaceRoot, signal);
            if (renderResult !== undefined) await renderResult;
        } catch (error: unknown) {
            renderError = error;
        }
        notifyInteractiveGraphSignalObservers(extraObservers, signal);
        if (renderError !== undefined) throw renderError;
    };
}

export function renderInteractiveGraphDurableEvent(
    output: ChatOutput,
    state: ProviderRenderState,
    event: AgentEvent,
): void {
    const emit = event.abg?.emit;
    if (emit === undefined) return;
    if (emit.type === 'llm.turn.completed') {
        output.clearAgentStatus?.();
        if (state.streamingThinking) {
            output.write('\n');
            state.streamingThinking = false;
        }
        if (state.toolCount > 0) {
            const noun = state.toolCount === 1 ? 'tool' : 'tools';
            output.write(`✓ ${state.toolCount} ${noun} (${formatToolCountSummary(state.toolNames)})\n`);
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
        if (text.length > 0) state.finalMessage = text;
        return;
    }
    if (emit.type === 'tool.completed' || emit.type === 'tool.failed') {
        state.toolCount += 1;
        state.toolNames = [...state.toolNames, readStringField(emit.payload, 'toolName') ?? 'tool'];
        output.clearAgentStatus?.();
        renderGraphToolSettlement(output, emit.payload, emit.type === 'tool.completed' ? 'completed' : 'failed');
        return;
    }
    if (emit.type === 'llm.error') {
        output.write(`Error: ${redactCredentialText(readStringField(emit.payload, 'error') ?? 'LLM error')}\n`);
    }
}

function renderInteractiveGraphSignal(
    output: ChatOutput,
    state: ProviderRenderState,
    workspaceRoot: string,
    signal: AbgSignal,
): Promise<void> | undefined {
    if (signal.type === 'started') {
        closeStreams(output, state);
        output.write(`▸ ${signal.nodeId}\n`);
        output.setAgentStatus?.(`${formatNodeLabel(signal.nodeId)}...`);
        return;
    }
    if (signal.type === 'failure') {
        output.clearAgentStatus?.();
        closeStreams(output, state);
        output.write(`✗ ${signal.nodeId}: ${extractSignalError(signal.error)}\n`);
        return;
    }
    if (signal.type === 'emit' && signal.event.type === 'llm.turn.started') {
        output.setAgentStatus?.('Thinking...');
        return;
    }
    const reasoningDelta = readReasoningDeltaFromSignal(signal);
    if (reasoningDelta !== undefined) {
        if (output.isShowThinking?.() !== false) {
            if (!state.streamingThinking) {
                if (state.streamingText) {
                    output.write('\n');
                    state.streamingText = false;
                }
                output.write('Thinking: ');
                state.streamingThinking = true;
            }
            output.write(reasoningDelta);
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
        output.setAgentStatus?.(`Running ${readStringField(signal.event.payload, 'toolName') ?? 'tool'}...`);
        return;
    }
    const proposal = readToolCallProposal(signal);
    if (proposal === undefined) return undefined;
    output.setAgentStatus?.(`Calling ${proposal.toolName}...`);
    if (state.streamingText) {
        output.write('\n');
        state.streamingText = false;
    }
    return renderToolPreview(proposal, output, workspaceRoot);
}

function renderGraphToolSettlement(output: ChatOutput, payload: unknown, status: 'completed' | 'failed'): void {
    const toolName = readStringField(payload, 'toolName') ?? 'tool';
    if (output.isToolOutputExpanded?.() === false) return;
    if (status === 'failed') {
        output.write(`${toolName} failed: ${redactCredentialText(readErrorMessage(payload) ?? 'unknown error')}\n`);
        return;
    }
    const modelOutput = readStringField(payload, 'output');
    const structured = structuredToolOutput(payload);
    if (toolName === 'file.patch') {
        const parsed = structured === undefined ? undefined : parseFilePatchOutput(structured);
        if (parsed !== undefined) output.write(`Applied patch: ${parsed.appliedFiles.join(', ')}\n`);
        return;
    }
    if (toolName === 'file.edit') {
        const parsed = structured === undefined ? undefined : parseFileEditOutput(structured);
        if (parsed !== undefined) {
            const noun = parsed.occurrencesReplaced === 1 ? 'occurrence' : 'occurrences';
            output.write(`Applied edit: ${parsed.appliedFiles.join(', ')} (${parsed.occurrencesReplaced} ${noun})\n`);
        }
        return;
    }
    if (toolName === 'file.write') {
        const parsed = structured === undefined ? undefined : parseFileWriteOutput(structured);
        if (parsed !== undefined)
            output.write(
                `${parsed.operation === 'created' ? 'Created' : 'Replaced'} file: ${parsed.appliedFiles.join(', ')}\n`,
            );
        return;
    }
    if (toolName === 'command.run' || toolName === 'bash.run') {
        output.write(`Command output for ${toolName}\n${modelOutput ?? ''}\n`);
    }
}

function closeStreams(output: ChatOutput, state: ProviderRenderState): void {
    if (state.streamingText || state.streamingThinking) output.write('\n');
    state.streamingText = false;
    state.streamingThinking = false;
}

const NODE_LABELS: Readonly<Record<string, string>> = {
    'intent-gate': 'Classifying intent',
    'direct-respond': 'Responding',
    'research-explore': 'Exploring',
    'route-planner': 'Planning',
    'maturity-check': 'Checking maturity',
    'anti-dup-guard': 'Checking for duplicates',
    'todo-plan': 'Planning tasks',
    'delegate-wave': 'Delegating',
    'delegate-worker': 'Working on task',
    'verify-wave': 'Verifying',
    'evidence-check': 'Checking evidence',
    supervisor: 'Reviewing progress',
    'final-respond': 'Composing answer',
    clarify: 'Asking for clarification',
};

function formatNodeLabel(nodeId: string): string {
    return NODE_LABELS[nodeId] ?? nodeId.replace(/-/g, ' ');
}

export type { ToolInvocationSettlement };
