import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { type ProjectTrustReader, ProjectTrustStore } from '../trust/project-trust-store.js';
import { type BrowserConnectFn, type BrowserToolAdvertisement, registerBrowserTool } from './browser-tool.js';
import { browserEndpointRedactionSecrets } from './browser-tool-url.js';
import { resolveUserConfigPath } from './mcp/config-paths.js';
import { readUserConfig } from './mcp/config-readers.js';
import type { LoadMcpConfigOptions } from './mcp/config-types.js';
import type { ToolRegistry } from './tool-registry.js';

export type RegisterConfiguredBrowserToolOptions = LoadMcpConfigOptions & {
    readonly workspaceRoot: string;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    readonly connect?: BrowserConnectFn;
    readonly projectTrustStore?: ProjectTrustReader;
};

export async function registerConfiguredBrowserTool(
    registry: ToolRegistry,
    options: RegisterConfiguredBrowserToolOptions,
): Promise<BrowserToolAdvertisement | null> {
    const userResult = await readUserConfig(resolveUserConfigPath(options));
    const endpoint = userResult.config?.browser;
    if (endpoint === undefined) return null;
    return registerBrowserTool(registry, {
        workspaceRoot: options.workspaceRoot,
        projectTrustStore: options.projectTrustStore ?? new ProjectTrustStore(),
        endpoint,
        requestPermission: options.requestPermission,
        redactionSecrets: browserEndpointRedactionSecrets(endpoint),
        ...(options.connect !== undefined ? { connect: options.connect } : {}),
    });
}
