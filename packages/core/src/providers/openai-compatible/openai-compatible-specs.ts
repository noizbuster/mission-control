export type OpenAICompatibleProviderID = 'openrouter' | 'groq' | 'deepseek' | 'mistral' | 'zai-coding-plan';

export type OpenAICompatibleProviderSpec = {
    readonly providerID: OpenAICompatibleProviderID;
    readonly endpoint: string;
    readonly unsupportedToolModelIDs?: readonly string[];
};

export const OPENAI_COMPATIBLE_PROVIDER_SPECS = [
    {
        providerID: 'openrouter',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    },
    {
        providerID: 'groq',
        endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    },
    {
        providerID: 'deepseek',
        endpoint: 'https://api.deepseek.com/chat/completions',
        unsupportedToolModelIDs: ['deepseek-reasoner'],
    },
    {
        providerID: 'mistral',
        endpoint: 'https://api.mistral.ai/v1/chat/completions',
    },
    {
        providerID: 'zai-coding-plan',
        endpoint: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
    },
] as const satisfies readonly OpenAICompatibleProviderSpec[];

const SPECS_BY_PROVIDER = new Map<string, OpenAICompatibleProviderSpec>(
    OPENAI_COMPATIBLE_PROVIDER_SPECS.map((spec) => [spec.providerID, spec]),
);

export function openAICompatibleProviderSpec(providerID: string): OpenAICompatibleProviderSpec | undefined {
    return SPECS_BY_PROVIDER.get(providerID);
}
