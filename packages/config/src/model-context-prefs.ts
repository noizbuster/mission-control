/**
 * Pure helpers for per-model context limits and auto-compaction thresholds.
 * Catalog defaults come from {@link getModelContextLimit}; user overrides are
 * stored as {@link ModelContextPreference} rows keyed by `providerID/modelID`.
 */

import type { ModelContextPreference, ModelProviderSelection } from '@mission-control/protocol';
import { getModelContextLimit } from './models-dev-runtime';

/** Discrete context-window steps (tokens) for left/right slider adjustment. */
export const MODEL_CONTEXT_LIMIT_STEPS = [
    8_000, 16_000, 32_000, 64_000, 128_000, 200_000, 256_000, 512_000, 1_000_000, 2_000_000,
] as const;

/**
 * Auto-compact thresholds as fractions of the effective context limit.
 * `0` disables auto-compaction.
 */
export const AUTO_COMPACT_THRESHOLD_STEPS = [0, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95] as const;

/** Variant-agnostic preference key: `providerID/modelID`. */
export function modelContextPreferenceKey(
    selection: Pick<ModelProviderSelection, 'providerID' | 'modelID'>,
): string {
    return `${selection.providerID}/${selection.modelID}`;
}

export function findModelContextPreference(
    prefs: readonly ModelContextPreference[],
    selection: Pick<ModelProviderSelection, 'providerID' | 'modelID'>,
): ModelContextPreference | undefined {
    const key = modelContextPreferenceKey(selection);
    return prefs.find((pref) => pref.modelKey === key);
}

/**
 * Effective context limit: user override when set, else catalog default.
 */
export function resolveEffectiveContextLimit(
    selection: Pick<ModelProviderSelection, 'providerID' | 'modelID'>,
    prefs: readonly ModelContextPreference[],
): number | undefined {
    const pref = findModelContextPreference(prefs, selection);
    if (pref?.contextLimit !== undefined) {
        return pref.contextLimit;
    }
    return getModelContextLimit(selection.providerID, selection.modelID);
}

/**
 * Auto-compact threshold fraction, or `undefined`/`0` when disabled.
 */
export function resolveAutoCompactThreshold(
    selection: Pick<ModelProviderSelection, 'providerID' | 'modelID'>,
    prefs: readonly ModelContextPreference[],
): number {
    const pref = findModelContextPreference(prefs, selection);
    return pref?.autoCompactThreshold ?? 0;
}

export function shouldAutoCompact(input: {
    readonly usedTokens: number | undefined;
    readonly contextLimit: number | undefined;
    readonly threshold: number;
}): boolean {
    if (input.threshold <= 0) return false;
    if (input.usedTokens === undefined || input.contextLimit === undefined) return false;
    if (input.contextLimit <= 0 || input.usedTokens < 0) return false;
    return input.usedTokens / input.contextLimit >= input.threshold;
}

/**
 * Step context limit by `direction` through discrete steps, including the
 * catalog default when known so users can restore it.
 */
export function stepContextLimit(input: {
    readonly current: number | undefined;
    readonly catalogDefault: number | undefined;
    readonly direction: 1 | -1;
}): number {
    const steps = buildContextLimitSteps(input.catalogDefault);
    const current = input.current ?? input.catalogDefault ?? steps[0] ?? 128_000;
    const index = nearestStepIndex(steps, current);
    const nextIndex = clampIndex(index + input.direction, steps.length);
    return steps[nextIndex] ?? current;
}

export function stepAutoCompactThreshold(current: number, direction: 1 | -1): number {
    const steps = AUTO_COMPACT_THRESHOLD_STEPS;
    const index = nearestStepIndex(steps, current);
    const nextIndex = clampIndex(index + direction, steps.length);
    return steps[nextIndex] ?? current;
}

/**
 * Upsert one preference row. Omitting both optional fields removes the row.
 */
export function upsertModelContextPreference(
    prefs: readonly ModelContextPreference[],
    next: ModelContextPreference,
): readonly ModelContextPreference[] {
    const without = prefs.filter((pref) => pref.modelKey !== next.modelKey);
    const hasContext = next.contextLimit !== undefined;
    const hasThreshold = next.autoCompactThreshold !== undefined && next.autoCompactThreshold > 0;
    if (!hasContext && !hasThreshold) {
        return without;
    }
    const cleaned: ModelContextPreference = {
        modelKey: next.modelKey,
        ...(hasContext ? { contextLimit: next.contextLimit } : {}),
        ...(hasThreshold ? { autoCompactThreshold: next.autoCompactThreshold } : {}),
    };
    return [...without, cleaned];
}

export function formatContextLimitLabel(tokens: number | undefined): string {
    if (tokens === undefined) return 'catalog';
    if (tokens >= 1_000_000) {
        const millions = tokens / 1_000_000;
        return Number.isInteger(millions) ? `${millions}M` : `${millions.toFixed(1)}M`;
    }
    if (tokens >= 1000) {
        const thousands = tokens / 1000;
        return Number.isInteger(thousands) ? `${thousands}k` : `${thousands.toFixed(0)}k`;
    }
    return String(tokens);
}

export function formatAutoCompactThresholdLabel(threshold: number): string {
    if (threshold <= 0) return 'off';
    return `${Math.round(threshold * 100)}%`;
}

export function renderSliderBar(input: {
    readonly value: number;
    readonly min: number;
    readonly max: number;
    readonly width?: number;
}): string {
    const width = input.width ?? 12;
    if (input.max <= input.min) {
        return `[${'#'.repeat(width)}]`;
    }
    const ratio = Math.min(1, Math.max(0, (input.value - input.min) / (input.max - input.min)));
    const filled = Math.round(ratio * width);
    const empty = Math.max(0, width - filled);
    return `[${'#'.repeat(filled)}${'-'.repeat(empty)}]`;
}

function buildContextLimitSteps(catalogDefault: number | undefined): readonly number[] {
    const set = new Set<number>(MODEL_CONTEXT_LIMIT_STEPS);
    if (catalogDefault !== undefined && catalogDefault > 0) {
        set.add(catalogDefault);
    }
    return [...set].sort((a, b) => a - b);
}

function nearestStepIndex(steps: readonly number[], value: number): number {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        if (step === undefined) continue;
        const distance = Math.abs(step - value);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
        }
    }
    return bestIndex;
}

function clampIndex(index: number, length: number): number {
    if (length <= 0) return 0;
    if (index < 0) return 0;
    if (index >= length) return length - 1;
    return index;
}
