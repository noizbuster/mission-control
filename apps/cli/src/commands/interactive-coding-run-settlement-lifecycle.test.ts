import type { SessionRunOwnerReceipt } from '@mission-control/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createStoredRichSettlementHarness,
    seedActiveToolTranscriptParts,
    settlementTimestamp,
    settleTestReceipt,
} from './interactive-coding-run-settlement-test-support';
import { createProviderRenderState } from './interactive-coding-transcript-render-state';
import { createPlainRecording } from './interactive-transcript-fallback-test-support';

const completedReceipt = {
    sessionId: 'session-receipt',
    runId: 'run-completed',
    status: 'completed',
    turns: 1,
} satisfies SessionRunOwnerReceipt;

const failedReceipt = {
    sessionId: 'session-receipt',
    runId: 'run-failed',
    status: 'failed',
    turns: 1,
    reason: 'receipt failed',
} satisfies SessionRunOwnerReceipt;

const interruptedReceipt = {
    sessionId: 'session-receipt',
    runId: 'run-interrupted',
    status: 'interrupted',
    turns: 1,
} satisfies SessionRunOwnerReceipt;

const blockedReceipt = {
    sessionId: 'session-receipt',
    runId: 'run-blocked',
    status: 'blocked_on_approval',
    turns: 1,
    reason: 'approval required',
    toolCallId: 'active-command',
} satisfies SessionRunOwnerReceipt;

describe('terminal active tool receipt settlement', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(settlementTimestamp));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it.each([
        {
            label: 'completed',
            receipt: completedReceipt,
            terminalStatus: 'completed',
            exactOutput: '\n---\nTurn elapsed: 1.23s · Stop reason: completed (run completed)\n',
        },
        {
            label: 'failed',
            receipt: failedReceipt,
            terminalStatus: 'failed',
            exactOutput: 'Error: receipt failed\n\n---\nTurn elapsed: 1.23s · Stop reason: failed (receipt failed)\n',
        },
    ] as const)('upserts active base and preview rows with the same IDs on $label receipts', ({
        receipt,
        terminalStatus,
        exactOutput,
    }) => {
        // Given
        const harness = createStoredRichSettlementHarness(`turn-${receipt.status}`);
        const active = seedActiveToolTranscriptParts(harness.output, harness.state);

        // When
        settleTestReceipt(harness.output, receipt, harness.state);

        // Then
        const activeRows = harness.store.getSnapshot().transcriptParts.filter((part) => active.ids.includes(part.id));
        expect(activeRows).toEqual(active.parts.map((part) => ({ ...part, status: terminalStatus })));
        expect(activeRows.map((part) => part.id)).toEqual(active.ids);
        expect(harness.state.activeToolTranscriptParts.size).toBe(0);
        expect(harness.state.pendingToolBaseIdsByRawId.size).toBe(0);
        expect(harness.store.getOutput()).toBe(exactOutput);
    });

    it('keeps interruption same-ID, idempotent, and byte-exact while clearing active allocation state', () => {
        // Given
        const harness = createStoredRichSettlementHarness('turn-interrupted');
        const active = seedActiveToolTranscriptParts(harness.output, harness.state);

        // When
        settleTestReceipt(harness.output, interruptedReceipt, harness.state);
        const settledSnapshot = harness.store.getSnapshot();
        const settledOutput = harness.store.getOutput();
        settleTestReceipt(harness.output, interruptedReceipt, harness.state);

        // Then
        const activeRows = settledSnapshot.transcriptParts.filter((part) => active.ids.includes(part.id));
        expect(activeRows).toEqual(active.parts.map((part) => ({ ...part, status: 'interrupted' })));
        expect(activeRows.map((part) => part.id)).toEqual(active.ids);
        expect(harness.state.activeToolTranscriptParts.size).toBe(0);
        expect(harness.state.pendingToolBaseIdsByRawId.size).toBe(0);
        expect(harness.store.getSnapshot()).toEqual(settledSnapshot);
        expect(settledOutput).toBe(
            'Interrupted active run\n\n---\nTurn elapsed: 1.23s · Stop reason: interrupted (interrupted by user)\n',
        );
        expect(harness.store.getOutput()).toBe(settledOutput);
    });

    it('keeps blocked active rows and the raw-ID FIFO queue resumable without typed terminal writes', () => {
        // Given
        const harness = createStoredRichSettlementHarness('turn-blocked');
        const active = seedActiveToolTranscriptParts(harness.output, harness.state);
        const transcriptBefore = harness.store.getSnapshot().transcriptParts;

        // When
        settleTestReceipt(harness.output, blockedReceipt, harness.state);

        // Then
        expect(harness.store.getSnapshot().transcriptParts.filter((part) => active.ids.includes(part.id))).toEqual(
            active.parts,
        );
        expect(harness.store.getSnapshot().transcriptParts.slice(0, transcriptBefore.length)).toEqual(transcriptBefore);
        expect([...harness.state.activeToolTranscriptParts.keys()]).toEqual(active.ids);
        expect(harness.state.pendingToolBaseIdsByRawId.get('active-command')).toEqual([active.baseId]);
        expect(harness.store.getOutput()).toBe(
            'Run blocked (resumable): approval required. Resume with /continue. Pending tool call: active-command.\n' +
                '\n---\nTurn elapsed: 1.23s · Stop reason: blocked (approval required)\n',
        );
    });

    it.each([
        {
            label: 'completed',
            receipt: completedReceipt,
            clearsActive: true,
            writes: ['\n---\nTurn elapsed: 1.23s · Stop reason: completed (run completed)\n'],
        },
        {
            label: 'failed',
            receipt: failedReceipt,
            clearsActive: true,
            writes: ['Error: receipt failed\n', '\n---\nTurn elapsed: 1.23s · Stop reason: failed (receipt failed)\n'],
        },
        {
            label: 'interrupted',
            receipt: interruptedReceipt,
            clearsActive: true,
            writes: [
                'Interrupted active run\n',
                '\n---\nTurn elapsed: 1.23s · Stop reason: interrupted (interrupted by user)\n',
            ],
        },
        {
            label: 'blocked',
            receipt: blockedReceipt,
            clearsActive: false,
            writes: [
                'Run blocked (resumable): approval required. Resume with /continue. Pending tool call: active-command.\n',
                '\n---\nTurn elapsed: 1.23s · Stop reason: blocked (approval required)\n',
            ],
        },
    ] as const)('keeps plain $label writes byte-exact with no empty typed writes', ({
        receipt,
        clearsActive,
        writes,
    }) => {
        // Given
        const plain = createPlainRecording();
        const state = createProviderRenderState(`plain-${receipt.status}`);
        const active = seedActiveToolTranscriptParts(plain.output, state);

        // When
        settleTestReceipt(plain.output, receipt, state);

        // Then
        expect(plain.writes).toEqual(writes);
        expect(plain.writes.every((write) => write.length > 0)).toBe(true);
        expect(state.activeToolTranscriptParts.size).toBe(clearsActive ? 0 : active.parts.length);
        expect(state.pendingToolBaseIdsByRawId.get('active-command')).toEqual(
            clearsActive ? undefined : [active.baseId],
        );
    });
});
