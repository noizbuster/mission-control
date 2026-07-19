import { createObservabilityRedactor, type SessionRunOwnerReceipt } from '@mission-control/core';
import { type AgentEvent, AgentEventSchema, type ModelProviderSelection } from '@mission-control/protocol';
import { createChatStore, type TranscriptPart } from '@mission-control/tui/state';
import { vi } from 'vitest';
import type { ChatOutput } from './interactive-chat-io';
import { settleReceipt } from './interactive-coding-run-settlement';
import {
    type ActiveToolTranscriptPart,
    allocateToolTranscriptOccurrence,
    createProviderRenderState,
    type ProviderRenderState,
    registerActiveToolTranscriptPart,
} from './interactive-coding-transcript-render-state';

export const settlementTimestamp = '2026-07-18T00:00:00.000Z';

const modelProviderSelection = {
    providerID: 'local',
    modelID: 'local-echo',
} satisfies ModelProviderSelection;

export type StoredRichSettlementHarness = {
    readonly store: ReturnType<typeof createChatStore>;
    readonly output: ChatOutput;
    readonly state: ProviderRenderState;
};

export function createStoredRichSettlementHarness(executionTurnId: string): StoredRichSettlementHarness {
    const store = createChatStore();
    store.emitTranscriptPart({ id: 'seed-status', type: 'status', text: 'running', status: 'running' }, '');
    return {
        store,
        output: {
            write: (text) => store.emitOutput(text),
            writeTranscriptPart: (part, fallbackText) => store.emitTranscriptPart(part, fallbackText),
            writeTranscriptFallback: (text) => store.emitTranscriptFallback(text),
        },
        state: createProviderRenderState(executionTurnId),
    };
}

export function seedActiveToolTranscriptParts(
    output: ChatOutput,
    state: ProviderRenderState,
    rawToolCallId = 'active-command',
): { readonly baseId: string; readonly ids: readonly string[]; readonly parts: readonly ActiveToolTranscriptPart[] } {
    const baseId = allocateToolTranscriptOccurrence(state, rawToolCallId);
    const parts = [
        {
            id: baseId,
            type: 'inline-tool',
            text: 'tool: command.run',
            toolCallId: rawToolCallId,
            toolName: 'command.run',
            status: 'pending',
        },
        {
            id: `${baseId}:preview`,
            type: 'command',
            text: '$ pnpm test',
            title: 'Command preview for command.run',
            detail: '$ pnpm test',
            command: 'pnpm test',
            toolCallId: rawToolCallId,
            status: 'pending',
        },
    ] satisfies readonly ActiveToolTranscriptPart[];
    for (const part of parts) {
        registerActiveToolTranscriptPart(state, part);
        output.writeTranscriptPart?.(part, '');
    }
    return { baseId, ids: parts.map((part) => part.id), parts };
}

export function failedReceipt(reason: string, runId?: string): SessionRunOwnerReceipt {
    return {
        sessionId: 'session-receipt',
        status: 'failed',
        turns: 1,
        reason,
        ...(runId !== undefined ? { runId } : {}),
    };
}

export function settleTestReceipt(
    output: ChatOutput,
    receipt: SessionRunOwnerReceipt,
    renderState: ProviderRenderState,
): readonly AgentEvent[] {
    const events: AgentEvent[] = [];
    settleReceipt({
        options: {
            sessionId: 'session-receipt',
            turnId: renderState.executionTurnId,
            modelProviderSelection,
            output,
            emitEvent: (event) => events.push(event),
        },
        receipt,
        renderState,
        observabilityRedactor: createObservabilityRedactor(),
        turnStartedAt: Date.now() - 1_230,
    });
    vi.runAllTimers();
    return events;
}

export function durableGraphError(nodeId: string, reason: string): AgentEvent {
    return AgentEventSchema.parse({
        type: 'model.call.failed',
        timestamp: settlementTimestamp,
        abg: { nodeId, emit: { type: 'llm.error', payload: { error: reason } } },
    });
}

export function errorParts(parts: readonly TranscriptPart[]): readonly TranscriptPart[] {
    return parts.filter((part) => part.type === 'error');
}

export function legacyText(parts: readonly TranscriptPart[]): string {
    return parts
        .filter((part) => part.type === 'legacy')
        .map((part) => part.text)
        .join('');
}

export function occurrenceCount(text: string, exact: string): number {
    return text.split(exact).length - 1;
}
