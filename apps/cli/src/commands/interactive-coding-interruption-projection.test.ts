import { createObservabilityRedactor, type SessionRunOwnerReceipt } from '@mission-control/core';
import { type AgentEvent, type ModelProviderSelection, ToolCallSchema } from '@mission-control/protocol';
import { createChatStore } from '@mission-control/tui/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatOutput } from './interactive-chat-io';
import { renderGraphToolSettlement } from './interactive-coding-graph-tool-rendering';
import { renderInteractiveToolSettlement } from './interactive-coding-provider-rendering';
import { settleReceipt } from './interactive-coding-run-settlement';
import { renderToolPreview } from './interactive-coding-tool-preview';
import { createProviderRenderState, type ProviderRenderState } from './interactive-coding-transcript-render-state';
import { completedSettlement } from './interactive-transcript-emission-test-support';

const timestamp = '2026-07-18T00:00:00.000Z';
const modelProviderSelection = {
    providerID: 'local',
    modelID: 'local-echo',
} satisfies ModelProviderSelection;

function createHarness(): {
    readonly store: ReturnType<typeof createChatStore>;
    readonly output: ChatOutput;
} {
    const store = createChatStore();
    store.emitTranscriptPart({ id: 'seed-status', type: 'status', text: 'running', status: 'running' }, '');
    return {
        store,
        output: {
            write: (text) => store.emitOutput(text),
            writeTranscriptPart: (part, fallbackText) => store.emitTranscriptPart(part, fallbackText),
            writeTranscriptFallback: (text) => store.emitTranscriptFallback(text),
        },
    };
}

function settleInterrupted(
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

describe('interrupted current-turn tool projections', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(timestamp));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('interrupts only the second reused occurrence after the first settles', async () => {
        // Given
        const harness = createHarness();
        const state = createProviderRenderState('turn/reused-interrupt');
        const toolCall = ToolCallSchema.parse({
            toolCallId: 'gemini_call_0:0',
            toolName: 'file.patch',
            argumentsJson: JSON.stringify({ patch: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n' }),
        });
        await renderToolPreview(toolCall, harness.output, { state });
        renderInteractiveToolSettlement(
            harness.output,
            completedSettlement({
                toolCallId: toolCall.toolCallId,
                toolName: toolCall.toolName,
                modelOutput: 'first patch applied',
                structuredOutput: { kind: 'file_patch', appliedFiles: ['a.txt'] },
            }),
            state,
        );
        await renderToolPreview(toolCall, harness.output, { state });
        const receipt: SessionRunOwnerReceipt = {
            sessionId: 'session-receipt',
            runId: 'run-reused-interrupted',
            status: 'interrupted',
            turns: 1,
        };

        // When
        settleInterrupted(harness.output, receipt, state);

        // Then
        expect(
            harness.store
                .getSnapshot()
                .transcriptParts.filter((part) => part.id.startsWith('tool:'))
                .map((part) => ({
                    id: part.id,
                    toolCallId: 'toolCallId' in part ? part.toolCallId : undefined,
                    status: 'status' in part ? part.status : undefined,
                })),
        ).toEqual([
            {
                id: 'tool:turn%2Freused-interrupt:gemini_call_0%3A0:occurrence:1',
                toolCallId: 'gemini_call_0:0',
                status: 'completed',
            },
            {
                id: 'tool:turn%2Freused-interrupt:gemini_call_0%3A0:occurrence:1:preview',
                toolCallId: 'gemini_call_0:0',
                status: 'completed',
            },
            {
                id: 'tool:turn%2Freused-interrupt:gemini_call_0%3A0:occurrence:2',
                toolCallId: 'gemini_call_0:0',
                status: 'interrupted',
            },
            {
                id: 'tool:turn%2Freused-interrupt:gemini_call_0%3A0:occurrence:2:preview',
                toolCallId: 'gemini_call_0:0',
                status: 'interrupted',
            },
        ]);
    });

    it('settles only remaining active base and preview rows in place before one interruption receipt', async () => {
        // Given
        const harness = createHarness();
        const state = createProviderRenderState('turn/interrupt');
        const providerCall = ToolCallSchema.parse({
            toolCallId: 'provider-completed',
            toolName: 'file.patch',
            argumentsJson: JSON.stringify({ patch: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n' }),
        });
        const graphCall = ToolCallSchema.parse({
            toolCallId: 'graph-completed',
            toolName: 'command.run',
            argumentsJson: JSON.stringify({ command: 'pnpm', args: ['test'] }),
        });
        const activeCall = ToolCallSchema.parse({
            toolCallId: 'active-command',
            toolName: 'command.run',
            argumentsJson: JSON.stringify({ command: 'pnpm', args: ['typecheck'] }),
        });
        await renderToolPreview(providerCall, harness.output, { state });
        renderInteractiveToolSettlement(
            harness.output,
            completedSettlement({
                toolCallId: providerCall.toolCallId,
                toolName: providerCall.toolName,
                modelOutput: 'patch applied',
                structuredOutput: { kind: 'file_patch', appliedFiles: ['a.txt'] },
            }),
            state,
        );
        await renderToolPreview(graphCall, harness.output, { state });
        renderGraphToolSettlement({
            output: harness.output,
            state,
            payload: {
                toolCallId: graphCall.toolCallId,
                toolName: graphCall.toolName,
                output: 'tests passed',
                structuredOutput: {
                    kind: 'command_run',
                    command: ['pnpm', 'test'],
                    status: 'completed',
                    exitCode: 0,
                },
            },
            status: 'completed',
        });
        harness.store.emitTranscriptPart(
            {
                id: 'tool:prior-turn:still-running',
                type: 'command',
                text: '$ prior command',
                title: 'Prior command',
                detail: '$ prior command',
                command: 'prior command',
                status: 'running',
            },
            '',
        );
        harness.store.emitTranscriptPart(
            { id: 'terminal-failed', type: 'inline-tool', text: 'failed', status: 'failed' },
            '',
        );
        harness.store.emitTranscriptPart(
            { id: 'terminal-denied', type: 'inline-tool', text: 'denied', status: 'denied' },
            '',
        );
        await renderToolPreview(activeCall, harness.output, { state });
        const beforeParts = harness.store.getSnapshot().transcriptParts;
        const beforeOutput = harness.store.getOutput();
        const activeIds = new Set([
            'tool:turn%2Finterrupt:active-command:occurrence:1',
            'tool:turn%2Finterrupt:active-command:occurrence:1:preview',
        ]);
        const activeBefore = beforeParts.filter((part) => activeIds.has(part.id));
        const isolatedIds = new Set([
            'tool:turn%2Finterrupt:provider-completed:occurrence:1',
            'tool:turn%2Finterrupt:provider-completed:occurrence:1:preview',
            'tool:turn%2Finterrupt:graph-completed:occurrence:1',
            'tool:turn%2Finterrupt:graph-completed:occurrence:1:preview',
            'tool:prior-turn:still-running',
            'terminal-failed',
            'terminal-denied',
        ]);
        const isolatedBefore = beforeParts.filter((part) => isolatedIds.has(part.id));
        const toolOrderBefore = beforeParts.filter((part) => part.id.startsWith('tool:')).map((part) => part.id);
        const receipt: SessionRunOwnerReceipt = {
            sessionId: 'session-receipt',
            runId: 'run-interrupted',
            status: 'interrupted',
            turns: 1,
        };

        // When
        const firstEvents = settleInterrupted(harness.output, receipt, state);

        // Then
        const afterFirstParts = harness.store.getSnapshot().transcriptParts;
        expect(afterFirstParts.filter((part) => activeIds.has(part.id))).toEqual(
            activeBefore.map((part) => ({ ...part, status: 'interrupted' })),
        );
        expect(afterFirstParts.filter((part) => isolatedIds.has(part.id))).toEqual(isolatedBefore);
        expect(afterFirstParts.filter((part) => part.id.startsWith('tool:')).map((part) => part.id)).toEqual(
            toolOrderBefore,
        );
        expect(harness.store.getOutput()).toBe(
            `${beforeOutput}Interrupted active run\n\n---\nTurn elapsed: 1.23s · Stop reason: interrupted (interrupted by user)\n`,
        );
        expect(firstEvents.filter((event) => event.type === 'task.failed')).toHaveLength(1);

        const settledSnapshot = harness.store.getSnapshot();
        const settledOutput = harness.store.getOutput();

        // When
        const repeatedEvents = settleInterrupted(harness.output, receipt, state);

        // Then
        expect(harness.store.getSnapshot()).toEqual(settledSnapshot);
        expect(harness.store.getOutput()).toBe(settledOutput);
        expect(repeatedEvents).toEqual([]);
    });
});
