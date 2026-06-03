import { missionControlAuthFileEnvKey, missionControlAuthSchemaURL } from '@mission-control/config';
import {
    type ModelProviderSelection,
    type ProviderAuthFile,
    ProviderAuthFileSchema,
    type ProviderCredentialSummary,
} from '@mission-control/protocol';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type SaveProviderCredentialInput = {
    readonly providerID: string;
    readonly modelID: string;
    readonly apiKey: string;
    readonly now: string;
};

export type ProviderAuthStore = {
    readonly authFilePath: string;
    readonly readAuthFile: () => Promise<ProviderAuthFile>;
    readonly saveCredential: (input: SaveProviderCredentialInput) => Promise<void>;
    readonly deleteCredential: (providerID: string) => Promise<void>;
    readonly listCredentialSummaries: () => Promise<readonly ProviderCredentialSummary[]>;
    readonly getDefaultSelection: () => Promise<ModelProviderSelection | undefined>;
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
                },
                credentials: {
                    ...current.credentials,
                    [input.providerID]: {
                        providerID: input.providerID,
                        type: 'apiKey',
                        apiKey: input.apiKey,
                        createdAt: existing?.createdAt ?? input.now,
                        updatedAt: input.now,
                    },
                },
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
            return Object.values(current.credentials).map((credential) => ({
                providerID: credential.providerID,
                authenticated: true,
                maskedCredential: maskCredential(credential.apiKey),
            }));
        },
        async getDefaultSelection() {
            const current = await readAuthFile(authFilePath);
            return current.default;
        },
    };
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
        return ProviderAuthFileSchema.parse(JSON.parse(await readFile(authFilePath, 'utf8')));
    } catch (error: unknown) {
        if (isMissingFileError(error)) {
            return defaultAuthFile;
        }
        throw error;
    }
}

async function writeAuthFile(authFilePath: string, authFile: ProviderAuthFile): Promise<void> {
    await mkdir(dirname(authFilePath), { recursive: true });
    await writeFile(authFilePath, `${JSON.stringify(authFile, null, 2)}\n`, { mode: 0o600 });
    await chmod(authFilePath, 0o600);
}

function maskCredential(apiKey: string): string {
    if (apiKey.length <= 8) {
        return '********';
    }
    return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
