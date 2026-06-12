import { OPENAI_COMPATIBLE_PROVIDER_SPECS } from './openai-compatible/openai-compatible-specs.js';
import type { ProviderAdapterContractRegistration } from './provider-adapter-contract-test-support.js';

const runnerProofs = {
    abort: 'provider-turn-runner.test.ts > emits typed abort and context overflow failures as replayable durable events',
    retryableError: 'provider-turn-runner.test.ts > retries retryable provider failures only up to the configured cap',
} as const;

export const localProviderContract = {
    adapterFamily: 'local',
    providerIDs: ['local'],
    scenarioProofs: {
        requestFormation:
            'provider-turn-runner.test.ts > streams deltas ephemerally and stores only durable final assistant history',
        toolsAdvertised:
            'deterministic-provider.ts is request-driven and ProviderTurnRunner preserves advertised request tools',
        toolCallParsed: 'provider-turn-runner.test.ts > stops scripted tool calls at the provider turn loop limit',
        toolResultContinuation:
            'runtime/run-coordinator.test.ts > provider tool result continuation uses deterministic provider turns',
        finalMessage:
            'provider-turn-runner.test.ts > streams deltas ephemerally and stores only durable final assistant history',
        abort: runnerProofs.abort,
        retryableError: runnerProofs.retryableError,
        authFailure:
            'local deterministic provider has no credential boundary; external executable adapters cover auth failures',
        redaction:
            'provider-redaction.test.ts > redacts token-like provider text before events JSONL replay and returned messages',
    },
} as const satisfies ProviderAdapterContractRegistration;

export const openAIResponsesProviderContract = {
    adapterFamily: 'openai-responses',
    providerIDs: ['openai'],
    scenarioProofs: {
        requestFormation:
            'openai/openai-responses-provider.test.ts > streams text chunks and disables OpenAI response storage by default',
        toolsAdvertised:
            'openai/openai-responses-provider.test.ts > sends tool definitions and function call outputs for Responses continuation',
        toolCallParsed:
            'openai/openai-responses-provider.test.ts > maps streamed function-call arguments to provider-neutral tool chunks without duplicates',
        toolResultContinuation:
            'openai/openai-responses-provider.test.ts > sends tool definitions and function call outputs for Responses continuation',
        finalMessage:
            'openai/openai-responses-provider.test.ts > streams text chunks and disables OpenAI response storage by default',
        abort: 'openai/openai-responses-errors.test.ts > passes the provider abort signal to the HTTP transport',
        retryableError:
            'openai/openai-responses-errors.test.ts > maps rate-limit context timeout and abort failures to typed provider errors',
        authFailure: 'openai/openai-responses-errors.test.ts > maps auth failures without exposing raw credentials',
        redaction: 'openai/openai-responses-errors.test.ts > redacts credentials from streamed OpenAI error events',
    },
} as const satisfies ProviderAdapterContractRegistration;

export const anthropicMessagesProviderContract = {
    adapterFamily: 'anthropic-messages',
    providerIDs: ['anthropic'],
    scenarioProofs: {
        requestFormation:
            'anthropic/anthropic-messages-provider.test.ts > streams text chunks and sends authenticated Messages requests with tools',
        toolsAdvertised:
            'anthropic/anthropic-messages-provider.test.ts > streams text chunks and sends authenticated Messages requests with tools',
        toolCallParsed:
            'anthropic/anthropic-messages-tools.test.ts > maps Anthropic tool_use blocks to provider-neutral tool calls and transcript metadata',
        toolResultContinuation:
            'anthropic/anthropic-messages-tools.test.ts > sends assistant tool_use and user tool_result blocks for continuation',
        finalMessage:
            'anthropic/anthropic-messages-provider.test.ts > streams text chunks and sends authenticated Messages requests with tools',
        abort: 'anthropic/anthropic-messages-contract.test.ts > maps abort failures without leaking the Anthropic API key',
        retryableError:
            'anthropic/anthropic-messages-contract.test.ts > maps retryable Anthropic rate-limit failures without leaking the API key',
        authFailure:
            'anthropic/anthropic-messages-provider.test.ts > maps auth failures without leaking the Anthropic API key',
        redaction:
            'anthropic/anthropic-messages-provider.test.ts > maps auth failures without leaking the Anthropic API key',
    },
} as const satisfies ProviderAdapterContractRegistration;

export const googleGeminiProviderContract = {
    adapterFamily: 'google-gemini',
    providerIDs: ['google'],
    scenarioProofs: {
        requestFormation:
            'google/gemini-generate-content-provider.test.ts > streams text chunks and sends authenticated requests with function declarations',
        toolsAdvertised:
            'google/gemini-generate-content-provider.test.ts > streams text chunks and sends authenticated requests with function declarations',
        toolCallParsed:
            'google/gemini-generate-content-tools.test.ts > maps functionCall parts to provider-neutral tool calls and transcript metadata',
        toolResultContinuation:
            'google/gemini-generate-content-tools.test.ts > sends model functionCall and user functionResponse parts for continuation',
        finalMessage:
            'google/gemini-generate-content-provider.test.ts > streams text chunks and sends authenticated requests with function declarations',
        abort: 'google/gemini-generate-content-provider.test.ts > maps auth and abort failures without leaking the Gemini API key',
        retryableError:
            'google/gemini-generate-content-contract.test.ts > maps retryable Gemini rate-limit failures without leaking the API key',
        authFailure:
            'google/gemini-generate-content-provider.test.ts > maps auth and abort failures without leaking the Gemini API key',
        redaction:
            'google/gemini-generate-content-provider.test.ts > maps auth and abort failures without leaking the Gemini API key',
    },
} as const satisfies ProviderAdapterContractRegistration;

export const openAICompatibleProviderContract = {
    adapterFamily: 'openai-compatible',
    providerIDs: OPENAI_COMPATIBLE_PROVIDER_SPECS.map((spec) => spec.providerID),
    scenarioProofs: {
        requestFormation:
            'openai-compatible/openai-compatible-provider.test.ts > sends Chat Completions tools through each provider and maps streamed tool-result continuation',
        toolsAdvertised:
            'openai-compatible/openai-compatible-provider.test.ts > sends Chat Completions tools through each provider and maps streamed tool-result continuation',
        toolCallParsed:
            'openai-compatible/openai-compatible-provider.test.ts > sends Chat Completions tools through each provider and maps streamed tool-result continuation',
        toolResultContinuation:
            'openai-compatible/openai-compatible-provider.test.ts > sends Chat Completions tools through each provider and maps streamed tool-result continuation',
        finalMessage:
            'openai-compatible/openai-compatible-provider.test.ts > sends Chat Completions tools through each provider and maps streamed tool-result continuation',
        abort: 'openai-compatible/openai-compatible-contract.test.ts > maps abort failures without leaking compatible provider tokens',
        retryableError:
            'openai-compatible/openai-compatible-contract.test.ts > maps retryable rate-limit failures without leaking compatible provider tokens',
        authFailure:
            'openai-compatible/openai-compatible-provider.test.ts > redacts each provider auth failure without leaking compatible provider tokens',
        redaction:
            'openai-compatible/openai-compatible-provider.test.ts > redacts each provider auth failure without leaking compatible provider tokens',
    },
} as const satisfies ProviderAdapterContractRegistration;

export const providerAdapterContractRegistrations = [
    localProviderContract,
    openAIResponsesProviderContract,
    anthropicMessagesProviderContract,
    googleGeminiProviderContract,
    openAICompatibleProviderContract,
] as const satisfies readonly ProviderAdapterContractRegistration[];
