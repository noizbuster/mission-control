import type { ContinuationState } from '@mission-control/core';
import { describe, expect, it } from 'vitest';
import { buildContinuationPanelView, DRAIN_TAB_MESSAGE, deriveContinuationReason } from './mission-panel-rows.js';

function makeState(overrides: Partial<ContinuationState> = {}): ContinuationState {
    return {
        iteration: 0,
        loopActive: false,
        doneSignal: false,
        lastSessionId: undefined,
        startedAt: '2026-07-02T13:45:00.000Z',
        ...overrides,
    };
}

describe('DRAIN_TAB_MESSAGE contract', () => {
    it('matches the documented inactive-state content verbatim', () => {
        expect(DRAIN_TAB_MESSAGE).toBe(
            'Drain Lane (RunCoordinatorV2) — Inactive\n' +
                '\n' +
                'Interactive mode uses SessionRunCoordinator (v1).\n' +
                'The V2 drain-lane coordinator is not active in interactive sessions.\n' +
                'It is available for workflow sessions only.',
        );
    });

    it('documents that interactive mode uses the v1 coordinator and V2 is inactive', () => {
        expect(DRAIN_TAB_MESSAGE).toContain('SessionRunCoordinator (v1)');
        expect(DRAIN_TAB_MESSAGE).toContain('RunCoordinatorV2');
        expect(DRAIN_TAB_MESSAGE).toContain('not active in interactive sessions');
        expect(DRAIN_TAB_MESSAGE).toContain('workflow sessions only');
    });
});

describe('deriveContinuationReason', () => {
    it('reports done_signal when the done flag is set', () => {
        expect(deriveContinuationReason(makeState({ doneSignal: true }))).toBe('done_signal');
    });

    it('reports done_signal even when the loop is still nominally active', () => {
        expect(deriveContinuationReason(makeState({ doneSignal: true, loopActive: true }))).toBe('done_signal');
    });

    it('reports loop_inactive when the loop is not active and no done signal', () => {
        expect(deriveContinuationReason(makeState({ loopActive: false }))).toBe('loop_inactive');
    });

    it('reports resumable when the loop is active with no done signal', () => {
        expect(deriveContinuationReason(makeState({ loopActive: true }))).toBe('resumable');
    });
});

describe('buildContinuationPanelView', () => {
    it('projects a resumable continuation carrying the last session id', () => {
        const state = makeState({
            iteration: 3,
            loopActive: true,
            lastSessionId: 'sess-abc-123',
            startedAt: '2026-07-02T10:00:00.000Z',
        });

        const view = buildContinuationPanelView(state);

        expect(view.iteration).toBe(3);
        expect(view.loopActive).toBe(true);
        expect(view.doneSignal).toBe(false);
        expect(view.lastSessionId).toBe('sess-abc-123');
        expect(view.startedAt).toBe('2026-07-02T10:00:00.000Z');
        expect(view.reason).toBe('resumable');
    });

    it('projects a done-signal continuation', () => {
        const view = buildContinuationPanelView(makeState({ iteration: 5, doneSignal: true, loopActive: false }));

        expect(view.doneSignal).toBe(true);
        expect(view.reason).toBe('done_signal');
    });

    it('projects an idle continuation with no last session', () => {
        const view = buildContinuationPanelView(makeState({ loopActive: false }));

        expect(view.loopActive).toBe(false);
        expect(view.lastSessionId).toBeUndefined();
        expect(view.reason).toBe('loop_inactive');
    });

    it('preserves the startedAt timestamp of the initial state', () => {
        const view = buildContinuationPanelView(makeState({ startedAt: '2026-01-01T00:00:00.000Z' }));

        expect(view.startedAt).toBe('2026-01-01T00:00:00.000Z');
    });
});
