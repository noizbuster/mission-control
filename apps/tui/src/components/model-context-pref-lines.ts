import {
    AUTO_COMPACT_THRESHOLD_STEPS,
    formatAutoCompactThresholdLabel,
    formatContextLimitLabel,
    MODEL_CONTEXT_LIMIT_STEPS,
    renderSliderBar,
    resolveAutoCompactThreshold,
    resolveEffectiveContextLimit,
} from '@mission-control/config';
import type { ModelContextPreference, ModelProviderSelection } from '@mission-control/protocol';

export type ModelContextPrefLines = {
    readonly contextLine: string;
    readonly compactLine: string;
    readonly effectiveContextLimit: number | undefined;
    readonly autoCompactThreshold: number;
};

export function buildModelContextPrefLines(
    selection: Pick<ModelProviderSelection, 'providerID' | 'modelID'>,
    prefs: readonly ModelContextPreference[],
): ModelContextPrefLines {
    const effectiveContextLimit = resolveEffectiveContextLimit(selection, prefs);
    const autoCompactThreshold = resolveAutoCompactThreshold(selection, prefs);
    const contextMin = MODEL_CONTEXT_LIMIT_STEPS[0] ?? 8_000;
    const contextMax = MODEL_CONTEXT_LIMIT_STEPS[MODEL_CONTEXT_LIMIT_STEPS.length - 1] ?? 2_000_000;
    const compactMin = AUTO_COMPACT_THRESHOLD_STEPS[0] ?? 0;
    const compactMax = AUTO_COMPACT_THRESHOLD_STEPS[AUTO_COMPACT_THRESHOLD_STEPS.length - 1] ?? 0.95;
    const contextBar = renderSliderBar({
        value: effectiveContextLimit ?? contextMin,
        min: contextMin,
        max: contextMax,
        width: 12,
    });
    const compactBar = renderSliderBar({
        value: autoCompactThreshold,
        min: compactMin,
        max: compactMax,
        width: 12,
    });
    return {
        contextLine: `Context  ${contextBar} ${formatContextLimitLabel(effectiveContextLimit)}  (-/=)`,
        compactLine: `Compact  ${compactBar} ${formatAutoCompactThresholdLabel(autoCompactThreshold)}  ([/])`,
        effectiveContextLimit,
        autoCompactThreshold,
    };
}
