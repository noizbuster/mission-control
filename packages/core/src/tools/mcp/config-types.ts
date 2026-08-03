import type { McpConfigEntry, MissionControlConfig, SessionDebugConfig } from '@mission-control/protocol';

export type McpConfigScope = 'user' | 'project';

export type ResolvedMcpServer =
    | {
          readonly name: string;
          readonly scope: McpConfigScope;
          readonly type: 'local';
          readonly enabled: boolean;
          readonly timeoutMs?: number;
          readonly command: readonly string[];
          readonly environment?: Readonly<Record<string, string>>;
      }
    | {
          readonly name: string;
          readonly scope: McpConfigScope;
          readonly type: 'remote';
          readonly enabled: boolean;
          readonly timeoutMs?: number;
          readonly url: string;
          readonly headers?: Readonly<Record<string, string>>;
      };

export type McpConfigParseError = {
    readonly source: string;
    readonly message: string;
};

export type ResolvedMcpConfig = {
    readonly config: MissionControlConfig;
    readonly sessionDebugConfig: SessionDebugConfig;
    readonly servers: readonly ResolvedMcpServer[];
    readonly expandedSecrets: readonly string[];
    readonly errors: readonly McpConfigParseError[];
    readonly sessionDebugError?: string;
};

export type LoadMcpConfigOptions = {
    readonly workspaceRoot?: string;
    readonly userConfigPath?: string;
    readonly userConfigDir?: string;
    readonly projectConfigPath?: string;
    readonly profileName?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
};

export type ScopedMcpEntry = {
    readonly entry: McpConfigEntry;
    readonly scope: McpConfigScope;
};
