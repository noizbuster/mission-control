type ModelVariantPreset = {
    readonly id: string;
    readonly name: string;
    readonly status: 'active';
};

const openAIReasoningVariants = [
    { id: 'reasoning-minimal', name: 'Reasoning Minimal', status: 'active' },
    { id: 'reasoning-low', name: 'Reasoning Low', status: 'active' },
    { id: 'reasoning-medium', name: 'Reasoning Medium', status: 'active' },
    { id: 'reasoning-high', name: 'Reasoning High', status: 'active' },
] as const satisfies readonly ModelVariantPreset[];

const openAILatestReasoningVariants = [
    { id: 'reasoning-none', name: 'Reasoning None', status: 'active' },
    { id: 'reasoning-low', name: 'Reasoning Low', status: 'active' },
    { id: 'reasoning-medium', name: 'Reasoning Medium', status: 'active' },
    { id: 'reasoning-high', name: 'Reasoning High', status: 'active' },
    { id: 'reasoning-xhigh', name: 'Reasoning XHigh', status: 'active' },
] as const satisfies readonly ModelVariantPreset[];

const anthropicThinkingVariants = [
    { id: 'thinking-off', name: 'Thinking Off', status: 'active' },
    { id: 'thinking-low', name: 'Thinking Low', status: 'active' },
    { id: 'thinking-medium', name: 'Thinking Medium', status: 'active' },
    { id: 'thinking-high', name: 'Thinking High', status: 'active' },
] as const satisfies readonly ModelVariantPreset[];

export function variantsForGeneratedModel(
    providerID: string,
    modelID: string,
): readonly ModelVariantPreset[] | undefined {
    switch (providerID) {
        case 'openai':
            if (isOpenAILatestReasoningModel(modelID)) {
                return openAILatestReasoningVariants;
            }
            return isOpenAIReasoningModel(modelID) ? openAIReasoningVariants : undefined;
        case 'anthropic':
            return isAnthropicThinkingModel(modelID) ? anthropicThinkingVariants : undefined;
        default:
            return undefined;
    }
}

function isOpenAILatestReasoningModel(modelID: string): boolean {
    return /^gpt-5\.(?:4|5)(?:[.-]|$)/.test(modelID);
}

function isOpenAIReasoningModel(modelID: string): boolean {
    return /^(gpt-5(?:[.-]|$)|o(?:1|3|4)(?:[.-]|$))/.test(modelID);
}

function isAnthropicThinkingModel(modelID: string): boolean {
    return /^(claude-3-7-|claude-(?:haiku|opus|sonnet)-4)/.test(modelID);
}
