import { createObservabilityRedactor, type SessionRunOwnerReceipt } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatOutput } from './interactive-chat-io';
import { settleReceipt } from './interactive-coding-run-settlement';
import { createProviderRenderState, type ProviderRenderState } from './interactive-coding-transcript-render-state';

const timestamp = '2026-07-18T00:00:00.000Z';
const modelProviderSelection = {
    providerID: 'local',
    modelID: 'local-echo',
} satisfies ModelProviderSelection;
const hostileDisplayPayload =
    'credential sk-displayblocker123 OSC:\u001b]52;c;UE9D\u0007 C0:\u0001 C1:\u009b CR:\r TAB:\t BIDI:\u202e';
const sanitizedDisplayPayload =
    'credential [REDACTED_CREDENTIAL] OSC:\\u{001B}]52;c;UE9D\\u{0007} C0:\\u{0001} C1:\\u{009B} CR:\\u{000D} TAB:\\u{0009} BIDI:\\u{202E}';

function settleTestReceipt(
    output: ChatOutput,
    receipt: SessionRunOwnerReceipt,
    renderState: ProviderRenderState,
): void {
    settleReceipt({
        options: {
            sessionId: 'session-receipt',
            turnId: renderState.executionTurnId,
            modelProviderSelection,
            output,
            emitEvent: () => undefined,
        },
        receipt,
        renderState,
        observabilityRedactor: createObservabilityRedactor(),
        turnStartedAt: Date.now() - 1_230,
    });
    vi.runAllTimers();
}

describe('terminal receipt display sanitization', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(timestamp));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('writes an ordinary Unicode final message into the completed footer byte-exactly', () => {
        // Given
        const writes: string[] = [];
        const state = createProviderRenderState('turn-completed-unicode');
        state.finalMessage = '完了しました ✅';

        // When
        settleTestReceipt(
            { write: (text) => writes.push(text) },
            {
                sessionId: 'session-receipt',
                runId: 'run-completed-unicode',
                status: 'completed',
                turns: 1,
            },
            state,
        );

        // Then
        expect(writes).toEqual(['\n---\nTurn elapsed: 1.23s · Stop reason: completed (完了しました ✅)\n']);
    });

    it('uses an empty-but-present final message instead of the absent fallback', () => {
        // Given
        const writes: string[] = [];
        const state = createProviderRenderState('turn-completed-empty');
        state.finalMessage = '';

        // When
        settleTestReceipt(
            { write: (text) => writes.push(text) },
            {
                sessionId: 'session-receipt',
                runId: 'run-completed-empty',
                status: 'completed',
                turns: 1,
            },
            state,
        );

        // Then
        expect(writes).toEqual(['\n---\nTurn elapsed: 1.23s · Stop reason: completed\n']);
    });

    it('uses run completed only when the final message is absent', () => {
        // Given
        const writes: string[] = [];
        const state = createProviderRenderState('turn-completed-absent');

        // When
        settleTestReceipt(
            { write: (text) => writes.push(text) },
            {
                sessionId: 'session-receipt',
                runId: 'run-completed-absent',
                status: 'completed',
                turns: 1,
            },
            state,
        );

        // Then
        expect(writes).toEqual(['\n---\nTurn elapsed: 1.23s · Stop reason: completed (run completed)\n']);
    });

    it('sanitizes hostile final-message controls while preserving LF, CJK, and ZWJ text', () => {
        // Given
        const writes: string[] = [];
        const state = createProviderRenderState('turn-completed-hostile');
        state.finalMessage = `${hostileDisplayPayload}\nCJK: 완료 ZWJ: 👩‍💻`;

        // When
        settleTestReceipt(
            { write: (text) => writes.push(text) },
            {
                sessionId: 'session-receipt',
                runId: 'run-completed-hostile',
                status: 'completed',
                turns: 1,
            },
            state,
        );

        // Then
        expect(writes).toEqual([
            `\n---\nTurn elapsed: 1.23s · Stop reason: completed (${sanitizedDisplayPayload}\nCJK: 완료 ZWJ: 👩‍💻)\n`,
        ]);
    });

    it('sanitizes failed reasons in the error and footer without mutating the receipt', () => {
        // Given
        const writes: string[] = [];
        const state = createProviderRenderState('turn-failed-footer');
        const receipt = {
            sessionId: 'session-receipt',
            runId: 'run-failed-footer',
            status: 'failed',
            turns: 1,
            reason: hostileDisplayPayload,
        } satisfies SessionRunOwnerReceipt;

        // When
        settleTestReceipt({ write: (text) => writes.push(text) }, receipt, state);

        // Then
        expect(writes).toEqual([
            `Error: ${sanitizedDisplayPayload}\n`,
            `\n---\nTurn elapsed: 1.23s · Stop reason: failed (${sanitizedDisplayPayload})\n`,
        ]);
        expect(receipt.reason).toBe(hostileDisplayPayload);
    });

    it('sanitizes blocked reasons and displayed tool IDs without mutating the receipt', () => {
        // Given
        const writes: string[] = [];
        const state = createProviderRenderState('turn-blocked-footer');
        const rawToolCallId = `tool-${hostileDisplayPayload}`;
        const receipt = {
            sessionId: 'session-receipt',
            runId: 'run-blocked-footer',
            status: 'blocked_on_approval',
            turns: 1,
            reason: hostileDisplayPayload,
            toolCallId: rawToolCallId,
        } satisfies SessionRunOwnerReceipt;

        // When
        settleTestReceipt({ write: (text) => writes.push(text) }, receipt, state);

        // Then
        expect(writes).toEqual([
            `Run blocked (resumable): ${sanitizedDisplayPayload}. Resume with /continue. Pending tool call: tool-${sanitizedDisplayPayload}.\n`,
            `\n---\nTurn elapsed: 1.23s · Stop reason: blocked (${sanitizedDisplayPayload})\n`,
        ]);
        expect(receipt.reason).toBe(hostileDisplayPayload);
        expect(receipt.toolCallId).toBe(rawToolCallId);
    });
});
