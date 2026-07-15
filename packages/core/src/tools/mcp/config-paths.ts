import { appName } from '@mission-control/config';
import type { LoadMcpConfigOptions } from './config-types.js';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const mcpConfigDirEnvKey = 'MCTRL_CONFIG_DIR';
const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class ProfileNameValidationError extends Error {
    readonly invalidValue: string | undefined;
    constructor(raw: string | undefined) {
        super(
            `Invalid profile name: ${JSON.stringify(raw)}. ` +
                'Profile names must start with a lowercase letter or digit and may contain only ' +
                "lowercase letters, digits, '_', or '-' (max 64 characters).",
        );
        this.name = 'ProfileNameValidationError';
        this.invalidValue = raw;
    }
}

export function validateProfileName(raw: string | undefined): string | undefined {
    if (raw === undefined) return undefined;
    if (!PROFILE_NAME_PATTERN.test(raw)) throw new ProfileNameValidationError(raw);
    return raw;
}

export function resolveUserProfileCandidates(
    profileName: string,
    options: LoadMcpConfigOptions = {},
): readonly string[] {
    validateProfileName(profileName);
    const directory = resolveConfigDirectory(options);
    return [
        join(directory, `mission-control.${profileName}.jsonc`),
        join(directory, `mission-control.${profileName}.json`),
        join(directory, `config.${profileName}.jsonc`),
        join(directory, `config.${profileName}.json`),
    ];
}

export function resolveUserConfigPath(options: LoadMcpConfigOptions = {}): string {
    if (options.profileName !== undefined) {
        validateProfileName(options.profileName);
        assertProfilePathOptions(options);
        const candidates = resolveUserProfileCandidates(options.profileName, options);
        const existing = candidates.find((candidate) => existsSync(candidate));
        if (existing !== undefined) return existing;
        throw new Error(
            `No config file found for profile ${JSON.stringify(options.profileName)}. ` +
                `Tried (in order): ${candidates.map((candidate) => JSON.stringify(candidate)).join(', ')}.`,
        );
    }
    return options.userConfigPath ?? join(resolveConfigDirectory(options), 'config.json');
}

export function resolveUserConfigPathForWrite(options: LoadMcpConfigOptions = {}): string {
    if (options.profileName === undefined) return resolveUserConfigPath(options);
    validateProfileName(options.profileName);
    assertProfilePathOptions(options);
    const candidates = resolveUserProfileCandidates(options.profileName, options);
    const existing = candidates.find((candidate) => existsSync(candidate));
    if (existing !== undefined) return existing;
    const createDefault = candidates[0];
    if (createDefault === undefined) throw new Error('unreachable: profile candidate list is empty');
    return createDefault;
}

export function resolveProjectConfigPath(options: LoadMcpConfigOptions = {}): string {
    if (options.projectConfigPath !== undefined) return options.projectConfigPath;
    return join(options.workspaceRoot ?? process.cwd(), '.mcp.json');
}

function resolveConfigDirectory(options: LoadMcpConfigOptions): string {
    if (options.userConfigDir !== undefined) return options.userConfigDir;
    const env = options.env ?? process.env;
    const override = env[mcpConfigDirEnvKey];
    if (override !== undefined && override.length > 0) return override;
    const homeDir = homedir();
    if (process.platform === 'win32') {
        const appData = env['APPDATA'];
        return join(
            appData !== undefined && appData.length > 0 ? appData : join(homeDir, 'AppData', 'Roaming'),
            appName,
        );
    }
    const xdgConfigHome = env['XDG_CONFIG_HOME'];
    return join(
        xdgConfigHome !== undefined && xdgConfigHome.length > 0 ? xdgConfigHome : join(homeDir, '.config'),
        appName,
    );
}

function assertProfilePathOptions(options: LoadMcpConfigOptions): void {
    if (options.userConfigPath === undefined || options.profileName === undefined) return;
    throw new Error(
        `Conflicting config options: userConfigPath (${JSON.stringify(options.userConfigPath)}) ` +
            `cannot be combined with profileName (${JSON.stringify(options.profileName)}). ` +
            'Provide userConfigDir (the directory) instead of userConfigPath to use profiles.',
    );
}
