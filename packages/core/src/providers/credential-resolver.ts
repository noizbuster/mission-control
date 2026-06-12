import type { ProviderCredential, ProviderCredentialSummary, RedactionMetadata } from '@mission-control/protocol';
import { credentialRedactionsForText, redactCredentialText } from './redaction-handler.js';

export {
    createCredentialRedactions,
    credentialRedactionsForText,
    REDACTED_CREDENTIAL,
    type RedactedCredentialLine,
    redactCredentialLines,
    redactCredentialText,
} from './redaction-handler.js';

export type ProviderCredentialResolveInput = {
    readonly providerID: string;
};

export interface ProviderCredentialResolver {
    readonly resolveProviderCredential: (
        input: ProviderCredentialResolveInput,
    ) => Promise<ProviderCredential | undefined>;
    readonly resolveRequiredProviderCredential: (input: ProviderCredentialResolveInput) => Promise<ProviderCredential>;
    readonly summarizeProviderCredential: (
        input: ProviderCredentialResolveInput,
    ) => Promise<ProviderCredentialSummary | undefined>;
    readonly redactForOutput: (text: string) => string;
}

export type ProviderCredentialResolutionErrorCode = 'credential_unavailable';

export type ProviderCredentialResolutionErrorInput = {
    readonly providerID: string;
    readonly code: ProviderCredentialResolutionErrorCode;
    readonly message: string;
    readonly secrets?: readonly string[];
};

export class ProviderCredentialResolutionError extends Error {
    readonly name = 'ProviderCredentialResolutionError';
    readonly providerID: string;
    readonly code: ProviderCredentialResolutionErrorCode;
    readonly redactions: readonly RedactionMetadata[];

    constructor(input: ProviderCredentialResolutionErrorInput) {
        const message = redactCredentialText(input.message, input.secrets ?? []);
        super(message);
        this.providerID = input.providerID;
        this.code = input.code;
        this.redactions = credentialRedactionsForText(input.message, input.secrets ?? []);
    }

    toJSON(): {
        readonly name: string;
        readonly providerID: string;
        readonly code: ProviderCredentialResolutionErrorCode;
        readonly message: string;
        readonly redactions: readonly RedactionMetadata[];
    } {
        return {
            name: this.name,
            providerID: this.providerID,
            code: this.code,
            message: this.message,
            redactions: this.redactions,
        };
    }
}

export function createStaticProviderCredentialResolver(
    credentials: readonly ProviderCredential[],
): ProviderCredentialResolver {
    const credentialsByProvider = new Map(credentials.map((credential) => [credential.providerID, credential]));
    const secrets = credentials.flatMap((credential) => credentialSecretValues(credential));

    return {
        async resolveProviderCredential(input) {
            return credentialsByProvider.get(input.providerID);
        },

        async resolveRequiredProviderCredential(input) {
            const credential = credentialsByProvider.get(input.providerID);
            if (credential !== undefined) {
                return credential;
            }
            throw new ProviderCredentialResolutionError({
                providerID: input.providerID,
                code: 'credential_unavailable',
                message: `provider credential is not configured for ${input.providerID}`,
                secrets,
            });
        },

        async summarizeProviderCredential(input) {
            const credential = credentialsByProvider.get(input.providerID);
            return credential === undefined ? undefined : summarizeResolvedProviderCredential(credential);
        },

        redactForOutput(text) {
            return redactCredentialText(text, secrets);
        },
    };
}

export function summarizeResolvedProviderCredential(credential: ProviderCredential): ProviderCredentialSummary {
    switch (credential.type) {
        case 'apiKey':
            return {
                providerID: credential.providerID,
                authenticated: true,
                maskedCredential: maskCredential(credential.apiKey),
            };
        case 'fields': {
            const fieldEntries = Object.entries(credential.fields).sort(([leftID], [rightID]) =>
                leftID.localeCompare(rightID),
            );
            const secretValue = fieldEntries.find((entry) => entry[1].secret)?.[1].value;
            const fieldCountLabel = formatFieldCount(fieldEntries.length);
            return {
                providerID: credential.providerID,
                authenticated: true,
                credentialType: 'fields',
                maskedCredential:
                    secretValue === undefined ? fieldCountLabel : `${maskCredential(secretValue)} (${fieldCountLabel})`,
                credentialFieldCount: fieldEntries.length,
            };
        }
        case 'oauth':
            return {
                providerID: credential.providerID,
                authenticated: true,
                credentialType: 'oauth',
                maskedCredential:
                    credential.accountLabel === undefined ? 'OAuth token' : `OAuth (${credential.accountLabel})`,
            };
        default:
            return assertNever(credential);
    }
}

function credentialSecretValues(credential: ProviderCredential): readonly string[] {
    switch (credential.type) {
        case 'apiKey':
            return [credential.apiKey];
        case 'fields':
            return Object.values(credential.fields)
                .filter((field) => field.secret)
                .map((field) => field.value);
        case 'oauth':
            return credential.refreshToken === undefined
                ? [credential.accessToken]
                : [credential.accessToken, credential.refreshToken];
        default:
            return assertNever(credential);
    }
}

function maskCredential(secret: string): string {
    if (secret.length <= 8) {
        return '********';
    }
    return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function formatFieldCount(fieldCount: number): string {
    return fieldCount === 1 ? '1 field' : `${fieldCount} fields`;
}

function assertNever(value: never): never {
    throw new TypeError(`Unexpected provider credential variant: ${JSON.stringify(value)}`);
}
