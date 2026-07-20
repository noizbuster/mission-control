import { describe, expect, it } from 'vitest';
import {
    formatAutoCompactThresholdLabel,
    formatContextLimitLabel,
    modelContextPreferenceKey,
    renderSliderBar,
    resolveAutoCompactThreshold,
    resolveEffectiveContextLimit,
    shouldAutoCompact,
    stepAutoCompactThreshold,
    stepContextLimit,
    upsertModelContextPreference,
} from './model-context-prefs';

describe('model context preference helpers', () => {
    it('builds a variant-agnostic model key', () => {
        // Given / When / Then
        expect(modelContextPreferenceKey({ providerID: 'openai', modelID: 'gpt-5' })).toBe('openai/gpt-5');
    });

    it('prefers user context override over catalog default', () => {
        // Given
        const selection = { providerID: 'local', modelID: 'local-echo' };
        const prefs = [{ modelKey: 'local/local-echo', contextLimit: 32_000 }];

        // When / Then
        expect(resolveEffectiveContextLimit(selection, prefs)).toBe(32_000);
        expect(resolveEffectiveContextLimit(selection, [])).toBeUndefined();
    });

    it('treats missing or zero auto-compact threshold as off', () => {
        // Given
        const selection = { providerID: 'openai', modelID: 'gpt-5' };

        // When / Then
        expect(resolveAutoCompactThreshold(selection, [])).toBe(0);
        expect(
            resolveAutoCompactThreshold(selection, [{ modelKey: 'openai/gpt-5', autoCompactThreshold: 0.8 }]),
        ).toBe(0.8);
    });

    it('gates auto-compact only when usage crosses the threshold', () => {
        // Given / When / Then
        expect(shouldAutoCompact({ usedTokens: 80_000, contextLimit: 100_000, threshold: 0.8 })).toBe(true);
        expect(shouldAutoCompact({ usedTokens: 79_999, contextLimit: 100_000, threshold: 0.8 })).toBe(false);
        expect(shouldAutoCompact({ usedTokens: 100_000, contextLimit: 100_000, threshold: 0 })).toBe(false);
        expect(shouldAutoCompact({ usedTokens: undefined, contextLimit: 100_000, threshold: 0.8 })).toBe(false);
    });

    it('steps context limit through discrete buckets including catalog default', () => {
        // Given / When / Then
        expect(stepContextLimit({ current: 128_000, catalogDefault: 200_000, direction: 1 })).toBe(200_000);
        expect(stepContextLimit({ current: 200_000, catalogDefault: 200_000, direction: -1 })).toBe(128_000);
        expect(stepContextLimit({ current: 8_000, catalogDefault: undefined, direction: -1 })).toBe(8_000);
    });

    it('steps auto-compact threshold including off', () => {
        // Given / When / Then
        expect(stepAutoCompactThreshold(0, 1)).toBe(0.5);
        expect(stepAutoCompactThreshold(0.5, -1)).toBe(0);
        expect(stepAutoCompactThreshold(0.95, 1)).toBe(0.95);
    });

    it('upserts and removes preference rows', () => {
        // Given
        const initial = [{ modelKey: 'a/b', contextLimit: 8_000 }];

        // When
        const withThreshold = upsertModelContextPreference(initial, {
            modelKey: 'a/b',
            contextLimit: 8_000,
            autoCompactThreshold: 0.8,
        });
        const cleared = upsertModelContextPreference(withThreshold, { modelKey: 'a/b' });

        // Then
        expect(withThreshold).toEqual([{ modelKey: 'a/b', contextLimit: 8_000, autoCompactThreshold: 0.8 }]);
        expect(cleared).toEqual([]);
    });

    it('formats labels and slider bars for the TUI', () => {
        // Given / When / Then
        expect(formatContextLimitLabel(200_000)).toBe('200k');
        expect(formatContextLimitLabel(1_000_000)).toBe('1M');
        expect(formatContextLimitLabel(undefined)).toBe('catalog');
        expect(formatAutoCompactThresholdLabel(0)).toBe('off');
        expect(formatAutoCompactThresholdLabel(0.8)).toBe('80%');
        expect(renderSliderBar({ value: 0.5, min: 0, max: 1, width: 4 })).toBe('[##--]');
    });
});
