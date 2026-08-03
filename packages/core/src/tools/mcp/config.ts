import type { McpConfig } from '@mission-control/protocol';
import type { ProjectTrustDecision } from '../../trust/project-trust-store';
import {
    mcpConfigDirEnvKey,
    ProfileNameValidationError,
    resolveProjectConfigPath,
    resolveUserConfigPath,
    resolveUserProfileCandidates,
    validateProfileName,
} from './config-paths';
import { type ReadProjectResult, type ReadUserResult, readProjectConfig, readUserConfig } from './config-readers';
import { resolveMcpServers } from './config-resolver';
import type {
    LoadMcpConfigOptions,
    McpConfigParseError,
    McpConfigScope,
    ResolvedMcpConfig,
    ResolvedMcpServer,
} from './config-types';
import {
    removeProjectMcpServer,
    removeUserMcpServer,
    writeProjectMcpServer,
    writeUserMcpServer,
} from './config-writes';

export type ReadScopeServersResult = {
    readonly servers: McpConfig;
    readonly allowlist?: readonly string[];
    readonly error?: string;
};

export type LoadRuntimeMcpConfigOptions = LoadMcpConfigOptions & {
    readonly projectTrustDecision: ProjectTrustDecision;
};

type ScopeResolutionInput = {
    readonly userConfigPath: string;
    readonly projectConfigPath: string;
    readonly userResult: ReadUserResult;
    readonly projectResult: ReadProjectResult;
    readonly env: Readonly<Record<string, string | undefined>>;
};

export async function loadResolvedMcpConfig(options: LoadMcpConfigOptions = {}): Promise<ResolvedMcpConfig> {
    const env = options.env ?? process.env;
    const userConfigPath = resolveUserConfigPath(options);
    const projectConfigPath = resolveProjectConfigPath(options);
    const userResult = await readUserConfig(userConfigPath);
    const projectResult = await readProjectConfig(projectConfigPath);
    return resolveScopeResults({ userConfigPath, projectConfigPath, userResult, projectResult, env });
}

export async function loadRuntimeMcpConfig(options: LoadRuntimeMcpConfigOptions): Promise<ResolvedMcpConfig> {
    const env = options.env ?? process.env;
    const userConfigPath = resolveUserConfigPath(options);
    const projectConfigPath = resolveProjectConfigPath(options);
    const userResult = await readUserConfig(userConfigPath);
    const projectResult: ReadProjectResult =
        options.projectTrustDecision === 'trusted' ? await readProjectConfig(projectConfigPath) : { config: undefined };
    return resolveScopeResults({ userConfigPath, projectConfigPath, userResult, projectResult, env });
}

function resolveScopeResults(input: ScopeResolutionInput): ResolvedMcpConfig {
    const errors: McpConfigParseError[] = [];
    if (input.userResult.error !== undefined) {
        errors.push({ source: input.userConfigPath, message: input.userResult.error });
    }
    if (input.projectResult.error !== undefined) {
        errors.push({ source: input.projectConfigPath, message: input.projectResult.error });
    }
    const allowlist = new Set<string>(input.userResult.config?.mcp_env_allowlist ?? []);
    const expandedSecrets = new Set<string>();
    const servers = resolveMcpServers(
        input.userResult.config?.mcp ?? {},
        input.projectResult.config?.mcpServers ?? {},
        allowlist,
        input.env,
        expandedSecrets,
    );
    return {
        config: input.userResult.config ?? {},
        sessionDebugConfig: input.userResult.sessionDebugConfig,
        servers,
        expandedSecrets: [...expandedSecrets],
        errors,
        ...(input.userResult.sessionDebugError !== undefined
            ? { sessionDebugError: input.userResult.sessionDebugError }
            : {}),
    };
}

export async function readUserScopeServers(options: LoadMcpConfigOptions = {}): Promise<ReadScopeServersResult> {
    const userResult = await readUserConfig(resolveUserConfigPath(options));
    return {
        servers: userResult.config?.mcp ?? {},
        ...(userResult.config?.mcp_env_allowlist !== undefined
            ? { allowlist: userResult.config.mcp_env_allowlist }
            : {}),
        ...(userResult.error !== undefined ? { error: userResult.error } : {}),
    };
}

export async function readProjectScopeServers(options: LoadMcpConfigOptions = {}): Promise<ReadScopeServersResult> {
    const projectResult = await readProjectConfig(resolveProjectConfigPath(options));
    return {
        servers: projectResult.config?.mcpServers ?? {},
        ...(projectResult.error !== undefined ? { error: projectResult.error } : {}),
    };
}

export type { LoadMcpConfigOptions, McpConfigParseError, McpConfigScope, ResolvedMcpConfig, ResolvedMcpServer };
export {
    mcpConfigDirEnvKey,
    ProfileNameValidationError,
    removeProjectMcpServer,
    removeUserMcpServer,
    resolveProjectConfigPath,
    resolveUserConfigPath,
    resolveUserProfileCandidates,
    validateProfileName,
    writeProjectMcpServer,
    writeUserMcpServer,
};
