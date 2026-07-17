import {
    buildTeamToolRegistrations,
    defaultVisionFetch,
    MonitorManagerClass,
    registerGenerateImageTool,
    registerGithubTool,
    registerInspectImageTool,
    registerLearnTool,
    registerLookAtTool,
    registerManageSkillTool,
    registerMemoryEditTool,
    registerMemoryRecallTool,
    registerMemoryReflectTool,
    registerMemoryRetainTool,
    registerMonitorListTool,
    registerMonitorOutputTool,
    registerMonitorStartTool,
    registerMonitorStopTool,
    registerTtsTool,
    resolveMemoryBackend,
    type ToolRegistry,
} from '@mission-control/core';
import type { ProductionToolCleanup } from './production-tool-registry';
import type { RegisterDefaultCodingToolsOptions } from './register-default-coding-tools';

export function registerDefaultMemoryTools(registry: ToolRegistry, options: RegisterDefaultCodingToolsOptions): void {
    const backendId = options.config.memory?.backend ?? 'off';
    if (backendId !== 'local') return;
    const backend = resolveMemoryBackend(backendId);
    registerMemoryRetainTool(registry, backend);
    registerMemoryRecallTool(registry, backend);
    registerMemoryReflectTool(registry, backend);
    registerMemoryEditTool(registry, backend);
    registerLearnTool(registry, backend);
    registerManageSkillTool(registry, backend);
}

export function registerDefaultTeamTools(registry: ToolRegistry, options: RegisterDefaultCodingToolsOptions): void {
    const config = options.config.team_mode;
    if (config?.enabled !== true) return;
    const registrations = buildTeamToolRegistrations({ root: options.workspaceRoot, config });
    for (const registration of registrations) {
        registry.register(registration);
    }
    // IRC additionally needs a caller identity paired with one live RuntimeAgentRegistry/IrcBus,
    // or a concrete TeamIrcBridge. Neither CLI root host owns that complete dependency set.
}

export async function registerDefaultExternalMediaTools(
    registry: ToolRegistry,
    options: RegisterDefaultCodingToolsOptions,
): Promise<void> {
    if (options.enableTrustedBash) {
        await registerGithubTool(registry, {
            workspaceRoot: options.workspaceRoot,
            workspaceTrust: 'trusted',
            requestPermission: options.requestPermission,
            ...(options.ghAvailable !== undefined ? { ghAvailable: options.ghAvailable } : {}),
            ...(options.commandExecutor !== undefined ? { executor: options.commandExecutor } : {}),
        });
    }
    const sessionId = options.sessionId ?? 'default';
    const workspaceAuthority = {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
    };
    await registerGenerateImageTool(registry, { sessionId, ...workspaceAuthority });
    await registerTtsTool(registry, { sessionId, ...workspaceAuthority });
    await registerLookAtTool(registry, workspaceAuthority);
    await registerInspectImageTool(registry, { ...workspaceAuthority, fetch: defaultVisionFetch });
    // SSH needs configured hosts and a production PTY transport; CLI owns no such transport today.
}

export async function registerDefaultMonitorTools(
    registry: ToolRegistry,
    options: RegisterDefaultCodingToolsOptions,
): Promise<ProductionToolCleanup | null> {
    const config = options.config.monitor;
    if (config?.enabled !== true) return null;
    const manager = new MonitorManagerClass({
        config: { maxMonitorsPerSession: config.maxMonitorsPerSession },
    });
    const shared = { manager, config, sessionId: options.sessionId ?? 'default' };
    await registerMonitorStartTool(registry, {
        ...shared,
        workspaceRoot: options.workspaceRoot,
        workspaceTrust: options.enableTrustedBash ? 'trusted' : 'unknown',
        requestPermission: options.requestPermission,
    });
    await registerMonitorStopTool(registry, shared);
    await registerMonitorListTool(registry, shared);
    await registerMonitorOutputTool(registry, shared);
    return () => manager.shutdown();
}
