import type { RawModelsDevReasoningOption } from './models-dev-runtime.js';

export type ModelVariantPreset = {
    readonly id: string;
    readonly name: string;
    readonly status: 'active';
};

// Providers that use the `thinking-*` variant prefix instead of `reasoning-*`.
const THINKING_PREFIX_PROVIDERS = new Set(['anthropic', 'google']);

// Google budget_tokens providers expose a continuous token range, not discrete
// effort values. Anthropic's older models (claude-opus-4-1 etc.) also use
// budget_tokens. Map both to the same three tiers.
const BUDGET_TOKEN_TIERS = [
    { id: 'thinking-low', name: 'Thinking Low' },
    { id: 'thinking-medium', name: 'Thinking Medium' },
    { id: 'thinking-high', name: 'Thinking High' },
] as const;

const BUDGET_TOKEN_PROVIDERS = new Set(['google', 'anthropic']);

/**
 * Derive variant presets from the model's `reasoning_options` metadata.
 *
 * - `effort` type: each value in `values` becomes a variant (`reasoning-{value}`
 *   or `thinking-{value}` depending on provider convention).
 * - `budget_tokens` type: only Google is mapped to discrete tiers (the budget
 *   range can't be auto-named). Other budget-type providers return undefined.
 * - `toggle` type: reasoning is always-on with no controllable variant → undefined.
 * - Absent: no reasoning control → undefined.
 */
export function variantsForReasoningOptions(
    providerID: string,
    reasoningOptions: readonly RawModelsDevReasoningOption[] | undefined,
): readonly ModelVariantPreset[] | undefined {
    if (reasoningOptions === undefined || reasoningOptions.length === 0) return undefined;

    for (const option of reasoningOptions) {
        if (option.type === 'effort' && option.values !== undefined && option.values.length > 0) {
            return effortVariants(providerID, option.values);
        }
        if (option.type === 'budget_tokens' && BUDGET_TOKEN_PROVIDERS.has(providerID)) {
            return BUDGET_TOKEN_TIERS.map((tier) => ({
                id: tier.id,
                name: tier.name,
                status: 'active' as const,
            }));
        }
    }
    return undefined;
}

function effortVariants(providerID: string, values: readonly string[]): readonly ModelVariantPreset[] {
    const prefix = THINKING_PREFIX_PROVIDERS.has(providerID) ? 'thinking-' : 'reasoning-';
    return values.map((value) => ({
        id: `${prefix}${value}`,
        name: variantDisplayName(value, prefix),
        status: 'active' as const,
    }));
}

function variantDisplayName(value: string, prefix: string): string {
    const label = value.charAt(0).toUpperCase() + value.slice(1);
    const kind = prefix === 'thinking-' ? 'Thinking' : 'Reasoning';
    return `${kind} ${label}`;
}
