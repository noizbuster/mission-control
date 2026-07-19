import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatOutput } from './interactive-chat-io';
import { interactiveGraphStreamSignal, renderInteractiveGraphDurableEvent } from './interactive-coding-graph-rendering';
import {
    createStoredRichSettlementHarness,
    durableGraphError,
    errorParts,
    failedReceipt,
    legacyText,
    occurrenceCount,
    settlementTimestamp,
    settleTestReceipt,
} from './interactive-coding-run-settlement-test-support';
import { graphFailure, turnStarted } from './interactive-transcript-fallback-test-support';

describe('failed graph receipt settlement', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(settlementTimestamp));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('adds nothing when a matching typed error and exact fallback were already emitted', async () => {
        // Given
        const secret = 'sk-receiptmatching123';
        const rawReason = `provider rejected ${secret}`;
        const redactedReason = 'provider rejected [REDACTED_CREDENTIAL]';
        const exactError = `Error: ${redactedReason}\n`;
        const rich = createStoredRichSettlementHarness('turn-matching');
        const state = rich.state;
        await interactiveGraphStreamSignal(rich.output, state, '/workspace')(turnStarted('answer-node', 'turn-one'));
        renderInteractiveGraphDurableEvent(rich.output, state, durableGraphError('answer-node', rawReason));

        // When
        const events = settleTestReceipt(rich.output, failedReceipt(rawReason, 'run-matching'), state);

        // Then
        expect(errorParts(rich.store.getSnapshot().transcriptParts)).toHaveLength(1);
        expect(occurrenceCount(rich.store.getOutput(), exactError)).toBe(1);
        expect(legacyText(rich.store.getSnapshot().transcriptParts)).not.toContain(exactError);
        expect(JSON.stringify(state)).toContain(redactedReason);
        expect(JSON.stringify(state)).not.toContain(secret);
        expect(events.filter((event) => event.type === 'task.failed')).toEqual([
            expect.objectContaining({
                type: 'task.failed',
                message: redactedReason,
                run: expect.objectContaining({ runId: 'run-matching', state: 'failed', reason: redactedReason }),
            }),
        ]);
        expect(rich.store.getOutput()).toContain(
            `\n---\nTurn elapsed: 1.23s · Stop reason: failed (${redactedReason})\n`,
        );
    });

    it('adds only the exact fallback when the matching live graph error already emitted a typed part', async () => {
        // Given
        const reason = 'live graph failed';
        const exactError = `Error: ${reason}\n`;
        const rich = createStoredRichSettlementHarness('turn-live');
        const state = rich.state;
        const stream = interactiveGraphStreamSignal(rich.output, state, '/workspace');
        await stream(turnStarted('failure-node', 'turn-live'));
        await stream(graphFailure('failure-node', reason));

        // When
        settleTestReceipt(rich.output, failedReceipt(reason, 'run-live'), state);

        // Then
        expect(errorParts(rich.store.getSnapshot().transcriptParts)).toHaveLength(1);
        expect(occurrenceCount(rich.store.getOutput(), exactError)).toBe(1);
        expect(legacyText(rich.store.getSnapshot().transcriptParts)).not.toContain(exactError);
    });

    it('adds a stable typed row with empty fallback when the exact fallback was already emitted', () => {
        // Given
        const reason = 'durable graph failed';
        const exactError = `Error: ${reason}\n`;
        const rich = createStoredRichSettlementHarness('turn-durable');
        const state = rich.state;
        renderInteractiveGraphDurableEvent(rich.output, state, durableGraphError('durable-node', reason));

        // When
        settleTestReceipt(rich.output, failedReceipt(reason, 'run/durable'), state);

        // Then
        expect(errorParts(rich.store.getSnapshot().transcriptParts)).toEqual([
            expect.objectContaining({ id: 'receipt:run%2Fdurable:error', type: 'error', text: reason }),
        ]);
        expect(occurrenceCount(rich.store.getOutput(), exactError)).toBe(1);
        expect(legacyText(rich.store.getSnapshot().transcriptParts)).not.toContain(exactError);
    });

    it.each([
        {
            label: 'no prior graph error',
            priorReason: undefined,
            runId: undefined,
            expectedId: 'receipt:turn%2Fmissing:error',
        },
        {
            label: 'a mismatched prior graph error',
            priorReason: 'earlier failure',
            runId: 'run/target',
            expectedId: 'receipt:run%2Ftarget:error',
        },
    ])('emits a typed row and exact fallback with $label', ({ priorReason, runId, expectedId }) => {
        // Given
        const reason = 'receipt-only failure';
        const exactError = `Error: ${reason}\n`;
        const rich = createStoredRichSettlementHarness('turn/missing');
        const state = rich.state;
        if (priorReason !== undefined) {
            renderInteractiveGraphDurableEvent(rich.output, state, durableGraphError('prior-node', priorReason));
        }

        // When
        settleTestReceipt(rich.output, failedReceipt(reason, runId), state);

        // Then
        expect(errorParts(rich.store.getSnapshot().transcriptParts)).toEqual([
            expect.objectContaining({ id: expectedId, type: 'error', text: reason }),
        ]);
        expect(occurrenceCount(rich.store.getOutput(), exactError)).toBe(1);
        expect(legacyText(rich.store.getSnapshot().transcriptParts)).not.toContain(exactError);
    });

    it('always writes the raw exact error on plain output even after a matching rich emission', async () => {
        // Given
        const reason = 'plain graph failed';
        const exactError = `Error: ${reason}\n`;
        const rich = createStoredRichSettlementHarness('turn-plain');
        const state = rich.state;
        await interactiveGraphStreamSignal(rich.output, state, '/workspace')(turnStarted('plain-node', 'turn-plain'));
        renderInteractiveGraphDurableEvent(rich.output, state, durableGraphError('plain-node', reason));
        const writes: string[] = [];
        const plainOutput: ChatOutput = { write: (text) => writes.push(text) };

        // When
        settleTestReceipt(plainOutput, failedReceipt(reason, 'run-plain'), state);

        // Then
        expect(writes[0]).toBe(exactError);
        expect(writes.join('')).toContain(`Stop reason: failed (${reason})`);
    });
});
