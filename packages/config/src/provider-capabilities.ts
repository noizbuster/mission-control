import type { ProviderExecutionCapability } from '@mission-control/protocol';

export const generatedProviderCapabilities: Readonly<Record<string, ProviderExecutionCapability>> = {
    openai: {
        status: 'executable',
        adapterFamily: 'openai-responses',
    },
    anthropic: {
        status: 'executable',
        adapterFamily: 'anthropic-messages',
    },
    google: {
        status: 'executable',
        adapterFamily: 'google-gemini',
    },
    openrouter: {
        status: 'executable',
        adapterFamily: 'openai-compatible',
    },
    groq: {
        status: 'executable',
        adapterFamily: 'openai-compatible',
    },
    deepseek: {
        status: 'executable',
        adapterFamily: 'openai-compatible',
    },
    mistral: {
        status: 'executable',
        adapterFamily: 'openai-compatible',
    },
    'zai-coding-plan': {
        status: 'executable',
        adapterFamily: 'openai-compatible',
    },
    'github-copilot': {
        status: 'auth-only',
    },
};

export const generatedDefaultProviderCapability = {
    status: 'model-discovery-only',
} as const satisfies ProviderExecutionCapability;
