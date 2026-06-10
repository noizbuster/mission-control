import { modelProviderCatalog } from '@mission-control/config';
import type { ProviderCredential, ToolDefinition } from '@mission-control/protocol';
import { ProviderCredentialResolutionError, type ProviderCredentialResolver } from '../credential-resolver.js';
import { ProviderTurnError, type ProviderTurnRequest } from '../provider-turn-types.js';
import type {
    OpenAIReasoningEffort,
    OpenAIResponsesRequestBody,
    OpenAIResponsesTool,
    OpenAIResponsesTransportRequest,
} from './openai-responses-transport.js';

export async function resolveOpenAICredential(
    resolver: ProviderCredentialResolver,
    providerID: string,
): Promise<ProviderCredential> {
    try {
        return await resolver.resolveRequiredProviderCredential({ providerID });
    } catch (error) {
        if (error instanceof ProviderCredentialResolutionError) {
            throw new ProviderTurnError({
                code: 'provider_auth_failed',
                message: error.message,
                retryable: false,
                ...(error.redactions.length > 0 ? { redactions: [...error.redactions] } : {}),
            });
        }
        throw error;
    }
}

export function createOpenAIResponsesTransportRequest(input: {
    readonly request: ProviderTurnRequest;
    readonly bearerToken: string;
    readonly signal: AbortSignal;
    readonly endpoint: string;
}): OpenAIResponsesTransportRequest {
    return {
        endpoint: input.endpoint,
        signal: input.signal,
        headers: {
            Authorization: `Bearer ${input.bearerToken}`,
            'Content-Type': 'application/json',
        },
        body: createRequestBody(input.request),
    };
}

export function bearerTokenForCredential(credential: ProviderCredential): string {
    switch (credential.type) {
        case 'apiKey':
            return credential.apiKey;
        case 'oauth':
            return credential.accessToken;
        case 'fields': {
            const secretField = Object.values(credential.fields).find((field) => field.secret);
            if (secretField !== undefined) {
                return secretField.value;
            }
            throw new ProviderTurnError({
                code: 'provider_auth_failed',
                message: `provider credential for ${credential.providerID} does not contain a bearer token`,
                retryable: false,
            });
        }
        default:
            return assertNever(credential);
    }
}

function createRequestBody(request: ProviderTurnRequest): OpenAIResponsesRequestBody {
    const tools = (request.tools ?? []).map(openAIToolForDefinition);
    const reasoning = openAIReasoningForVariant(request.modelID, request.variantID);
    return {
        model: request.modelID,
        input: request.messages.map((message) => ({ role: message.role, content: message.content })),
        stream: true,
        store: false,
        stream_options: { include_obfuscation: false },
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(tools.length > 0 ? { tools } : {}),
    };
}

function openAIReasoningForVariant(
    modelID: string,
    variantID: string | undefined,
): { readonly effort: OpenAIReasoningEffort } | undefined {
    if (variantID === undefined || !isConfiguredOpenAIVariant(modelID, variantID)) {
        return undefined;
    }
    switch (variantID) {
        case 'reasoning-none':
            return { effort: 'none' };
        case 'reasoning-minimal':
            return { effort: 'minimal' };
        case 'reasoning-low':
            return { effort: 'low' };
        case 'reasoning-medium':
            return { effort: 'medium' };
        case 'reasoning-high':
            return { effort: 'high' };
        case 'reasoning-xhigh':
            return { effort: 'xhigh' };
        default:
            return undefined;
    }
}

function isConfiguredOpenAIVariant(modelID: string, variantID: string): boolean {
    const openAIProvider = modelProviderCatalog.find((provider) => provider.id === 'openai');
    const model = openAIProvider?.models.find((entry) => entry.id === modelID);
    return (model?.variants ?? []).some((variant) => variant.id === variantID);
}

function openAIToolForDefinition(tool: ToolDefinition): OpenAIResponsesTool {
    return {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parametersJsonSchema,
    };
}

function assertNever(value: never): never {
    throw new TypeError(`Unexpected OpenAI credential variant: ${JSON.stringify(value)}`);
}
