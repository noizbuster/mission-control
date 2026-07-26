import { missionControlAuthFileEnvKey, missionControlAuthSchemaURL } from '@mission-control/config';
import {
    type ModelProviderSelection,
    type ProviderAuthFile,
    ProviderAuthFileSchema,
    type ProviderCredential,
    type ProviderCredentialSummary,
} from '@mission-control/protocol';
import type { ModelRole } from '../agents/model-roles';
import { atomicWriteFile } from '../persistence/atomic-write';
import { chmod, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type SaveProviderCredentialFieldInput = {
    readonly id: string;
    readonly value: string;
    readonly secret: boolean;
};

export type SaveProviderOAuthCredentialInput = {
    readonly accessToken: string;
    readonly refreshToken?: string;
    readonly expiresAt?: string;
    readonly scopes?: readonly string[];
    readonly accountLabel?: string;
};

type SaveProviderCredentialBaseInput = {
    readonly providerID: string;
    readonly modelID: string;
    readonly variantID?: string;
    readonly now: string;
};

export type SaveProviderCredentialInput =
    | (SaveProviderCredentialBaseInput & {
          readonly apiKey: string;
      })
    | (SaveProviderCredentialBaseInput & {
          readonly fields: readonly SaveProviderCredentialFieldInput[];
      })
    | (SaveProviderCredentialBaseInput & {
          readonly oauth: SaveProviderOAuthCredentialInput;
      });

export type ProviderAuthStore = {
    readonly authFilePath: string;
    readonly readAuthFile: () => Promise<ProviderAuthFile>;
    readonly saveCredential: (input: SaveProviderCredentialInput) => Promise<void>;
    readonly updateOAuthCredential: (
        providerID: string,
        oauth: SaveProviderOAuthCredentialInput,
        now?: string,
    ) => Promise<void>;
    readonly setDefaultSelection: (selection: ModelProviderSelection) => Promise<void>;
    readonly deleteCredential: (providerID: string) => Promise<void>;
    readonly listCredentialSummaries: () => Promise<readonly ProviderCredentialSummary[]>;
    readonly getDefaultSelection: () => Promise<ModelProviderSelection | undefined>;
    readonly getModelRoles: () => Promise<Partial<Record<ModelRole, ModelProviderSelection>>>;
    readonly setModelRole: (role: ModelRole, selection: ModelProviderSelection) => Promise<void>;
    readonly clearModelRole: (role: ModelRole) => Promise<void>;
};

const defaultAuthFile = {
    $schema: missionControlAuthSchemaURL,
    credentials: {},
} satisfies ProviderAuthFile;

export function createProviderAuthStore(): ProviderAuthStore {
    const authFilePath = resolveAuthFilePath();
    return {
        authFilePath,
        async readAuthFile() {
            return readAuthFile(authFilePath);
        },
        async saveCredential(input) {
            const current = await readAuthFile(authFilePath);
            const existing = current.credentials[input.providerID];
            const next = ProviderAuthFileSchema.parse({
                ...current,
                default: {
                    providerID: input.providerID,
                    modelID: input.modelID,
                    ...(input.variantID !== undefined ? { variantID: input.variantID } : {}),
                },
                credentials: {
                    ...current.credentials,
                    [input.providerID]: buildStoredCredential(input, existing),
                },
            });
            await writeAuthFile(authFilePath, next);
        },
        async updateOAuthCredential(providerID, oauth, now = new Date().toISOString()) {
            const current = await readAuthFile(authFilePath);
            const existing = current.credentials[providerID];
            if (existing === undefined || existing.type !== 'oauth') {
                throw new Error(`OAuth credential is not configured for ${providerID}`);
            }
            const nextCredential: ProviderCredential = {
                providerID,
                type: 'oauth',
                accessToken: oauth.accessToken,
                createdAt: existing.createdAt,
                updatedAt: now,
                ...(oauth.refreshToken !== undefined
                    ? { refreshToken: oauth.refreshToken }
                    : existing.refreshToken !== undefined
                      ? { refreshToken: existing.refreshToken }
                      : {}),
                ...(oauth.expiresAt !== undefined
                    ? { expiresAt: oauth.expiresAt }
                    : existing.expiresAt !== undefined
                      ? { expiresAt: existing.expiresAt }
                      : {}),
                ...(oauth.scopes !== undefined
                    ? { scopes: [...oauth.scopes] }
                    : existing.scopes !== undefined
                      ? { scopes: [...existing.scopes] }
                      : {}),
                ...(oauth.accountLabel !== undefined
                    ? { accountLabel: oauth.accountLabel }
                    : existing.accountLabel !== undefined
                      ? { accountLabel: existing.accountLabel }
                      : {}),
            };
            const next = ProviderAuthFileSchema.parse({
                ...current,
                credentials: {
                    ...current.credentials,
                    [providerID]: nextCredential,
                },
            });
            await writeAuthFile(authFilePath, next);
        },
        async setDefaultSelection(selection) {
            const current = await readAuthFile(authFilePath);
            const next = ProviderAuthFileSchema.parse({
                ...current,
                default: selection,
            });
            await writeAuthFile(authFilePath, next);
        },
        async deleteCredential(providerID) {
            const current = await readAuthFile(authFilePath);
            const credentials = Object.fromEntries(
                Object.entries(current.credentials).filter(
                    ([credentialProviderID]) => credentialProviderID !== providerID,
                ),
            );
            const next = ProviderAuthFileSchema.parse({
                ...current,
                ...(current.default?.providerID === providerID ? { default: undefined } : { default: current.default }),
                credentials,
            });
            await writeAuthFile(authFilePath, next);
        },
        async listCredentialSummaries() {
            const current = await readAuthFile(authFilePath);
            return Object.values(current.credentials).map(summarizeCredential);
        },
        async getDefaultSelection() {
            const current = await readAuthFile(authFilePath);
            return current.default;
        },
        async getModelRoles() {
            const current = await readAuthFile(authFilePath);
            return current.modelRoles ?? {};
        },
        async setModelRole(role, selection) {
            const current = await readAuthFile(authFilePath);
            const next = ProviderAuthFileSchema.parse({
                ...current,
                modelRoles: { ...(current.modelRoles ?? {}), [role]: selection },
            });
            await writeAuthFile(authFilePath, next);
        },
        async clearModelRole(role) {
            const current = await readAuthFile(authFilePath);
            const modelRoles: Record<string, ModelProviderSelection> = { ...(current.modelRoles ?? {}) };
            delete modelRoles[role];
            const next = ProviderAuthFileSchema.parse({
                ...current,
                modelRoles,
            });
            await writeAuthFile(authFilePath, next);
        },
    };
}

function buildStoredCredential(
    input: SaveProviderCredentialInput,
    existing: ProviderCredential | undefined,
): ProviderCredential {
    if ('apiKey' in input) {
        return {
            providerID: input.providerID,
            type: 'apiKey',
            apiKey: input.apiKey,
            createdAt: existing?.createdAt ?? input.now,
            updatedAt: input.now,
        };
    }

    if ('oauth' in input) {
        return {
            providerID: input.providerID,
            type: 'oauth',
            accessToken: input.oauth.accessToken,
            ...(input.oauth.refreshToken !== undefined ? { refreshToken: input.oauth.refreshToken } : {}),
            ...(input.oauth.expiresAt !== undefined ? { expiresAt: input.oauth.expiresAt } : {}),
            ...(input.oauth.scopes !== undefined ? { scopes: [...input.oauth.scopes] } : {}),
            ...(input.oauth.accountLabel !== undefined ? { accountLabel: input.oauth.accountLabel } : {}),
            createdAt: existing?.createdAt ?? input.now,
            updatedAt: input.now,
        };
    }

    return {
        providerID: input.providerID,
        type: 'fields',
        fields: Object.fromEntries(
            input.fields.map((field) => [
                field.id,
                {
                    value: field.value,
                    secret: field.secret,
                },
            ]),
        ),
        createdAt: existing?.createdAt ?? input.now,
        updatedAt: input.now,
    };
}

function summarizeCredential(credential: ProviderCredential): ProviderCredentialSummary {
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
                maskedCredential: formatOAuthCredentialLabel(credential.accountLabel),
            };
        default:
            return assertNever(credential);
    }
}

function resolveAuthFilePath(): string {
    const override = process.env[missionControlAuthFileEnvKey];
    if (override !== undefined && override.length > 0) {
        return override;
    }
    const xdgDataHome = process.env['XDG_DATA_HOME'];
    const dataHome =
        xdgDataHome !== undefined && xdgDataHome.length > 0 ? xdgDataHome : join(homedir(), '.local', 'share');
    return join(dataHome, 'mission-control', 'auth.json');
}

async function readAuthFile(authFilePath: string): Promise<ProviderAuthFile> {
    try {
        const contents = await readFile(authFilePath, 'utf8');
        await chmod(authFilePath, 0o600);
        if (contents.trim().length === 0) {
            return defaultAuthFile;
        }
        return ProviderAuthFileSchema.parse(JSON.parse(contents));
    } catch (error: unknown) {
        if (isMissingFileError(error)) {
            return defaultAuthFile;
        }
        throw error;
    }
}

async function writeAuthFile(authFilePath: string, authFile: ProviderAuthFile): Promise<void> {
    await atomicWriteFile(authFilePath, `${JSON.stringify(authFile, null, 2)}\n`, { mode: 0o600 });
}

function maskCredential(apiKey: string): string {
    if (apiKey.length <= 8) {
        return '********';
    }
    return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

function formatFieldCount(fieldCount: number): string {
    return fieldCount === 1 ? '1 field' : `${fieldCount} fields`;
}

function formatOAuthCredentialLabel(accountLabel: string | undefined): string {
    return accountLabel === undefined ? 'OAuth token' : `OAuth (${accountLabel})`;
}

function assertNever(value: never): never {
    void value;
    throw new Error('Unhandled provider credential type');
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
