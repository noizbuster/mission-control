import {
    createJobToolRegistration,
    createResolveToolRegistration,
    createSessionInfoToolRegistration,
    createSessionListToolRegistration,
    createSessionReadToolRegistration,
    createSessionSearchToolRegistration,
    discoverSkills,
    type ObservabilityRedactor,
    ProjectTrustStore,
    registerAskUserTool,
    registerAstEditTool,
    registerAstGrepTool,
    registerBashRunTool,
    registerCommandRunTool,
    registerEvalTool,
    registerFileEditTool,
    registerFilePatchTool,
    registerFileWriteTool,
    registerFullParityTaskTool,
    registerGlobTool,
    registerHashlineEditTool,
    registerInteractiveBashTool,
    registerReadOnlyRepoTools,
    registerRipgrepTool,
    registerSkillTool,
    registerWebfetchTool,
    registerWebSearchTool,
    registerWorkflowTool,
    type StagedPreviewRegistry,
    selectWebSearchProvider,
    type ToolRegistry,
    todoWriteToolRegistration,
} from '@mission-control/core';
import type { AbgNodeModelOptions } from '@mission-control/protocol';
import { readModelPatternOverrides } from './agents-model-overrides-config';
import { cliAllowsAction } from './cli-permission-policy';
import { buildRoleConfigFromAuth } from './model-role-config';
import type { RegisterDefaultCodingToolsOptions } from './register-default-coding-tools';
import { registerDefaultExternalMediaTools, registerDefaultMemoryTools } from './register-default-configured-tools';
import { registerDefaultOrchestrationTools } from './register-default-orchestration-tools';

export async function registerDefaultCodingToolBase(
    registry: ToolRegistry,
    stagedPreviewRegistry: StagedPreviewRegistry,
    options: RegisterDefaultCodingToolsOptions,
): Promise<void> {
    await registerReadOnlyRepoTools(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
        natives: options.natives,
    });
    registry.register(createSessionListToolRegistration(options.sessionTools));
    registry.register(createSessionReadToolRegistration(options.sessionTools));
    registry.register(createSessionInfoToolRegistration(options.sessionTools));
    registry.register(createSessionSearchToolRegistration(options.sessionTools));
    await registerGlobTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
    });
    await registerRipgrepTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
    });
    await registerAstGrepTool(registry, {
        workspaceRoot: options.workspaceRoot,
        registry: stagedPreviewRegistry,
        requestPermission: options.requestPermission,
    });
    await registerAstEditTool(registry, {
        workspaceRoot: options.workspaceRoot,
        registry: stagedPreviewRegistry,
        requestPermission: options.requestPermission,
    });
    registry.register(createResolveToolRegistration({ registry: stagedPreviewRegistry }));
    registry.register(todoWriteToolRegistration);
    const skillDiscovery = await discoverSkills({ workspaceRoot: options.workspaceRoot });
    registerSkillTool(registry, { skills: skillDiscovery.skills });
    registerDefaultMemoryTools(registry, options);
    if (options.workflowRegistry !== undefined) {
        registerWorkflowTool(registry, {
            registry: options.workflowRegistry,
            ...(options.onWorkflowStarted !== undefined ? { onWorkflowStarted: options.onWorkflowStarted } : {}),
        });
    }
    await registerWebfetchTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
    });
    if (selectWebSearchProvider() !== undefined) {
        await registerWebSearchTool(registry, {
            sessionId: options.sessionId ?? 'default',
            ...(options.natives.available ? { natives: options.natives } : {}),
        });
    }
    await registerAskUserForHost(registry, options);
    await registerMutationTools(registry, options);
    await registerDefaultExternalMediaTools(registry, options);
    registerDefaultOrchestrationTools(registry, options);
}

export async function registerDefaultTaskTool(
    registry: ToolRegistry,
    options: RegisterDefaultCodingToolsOptions,
    observabilityRedactor?: ObservabilityRedactor,
): Promise<void> {
    const resolveSdkModel = options.resolveSdkModel;
    const selection = options.modelProviderSelection;
    if (resolveSdkModel === undefined || selection === undefined) return;
    const model: AbgNodeModelOptions = {
        providerID: selection.providerID,
        modelID: selection.modelID,
        ...(selection.variantID !== undefined ? { variantID: selection.variantID } : {}),
    };
    const agentModelOverrides = await readModelPatternOverrides({ workspaceRoot: options.workspaceRoot });
    const roleConfig = options.authStore !== undefined ? await buildRoleConfigFromAuth(options.authStore) : undefined;
    const hostCallbacks =
        options.hostKind === 'interactive'
            ? options.childHostCallbacks
            : observabilityRedactor === undefined
              ? undefined
              : { observabilityRedactor };
    await registerFullParityTaskTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
        resolveSdkModel,
        model,
        parentToolRegistry: registry,
        isCliRootParent: true,
        agentModelOverrides,
        ...(roleConfig !== undefined ? { roleConfig } : {}),
        ...(options.sessionId !== undefined ? { parentSessionId: options.sessionId } : {}),
        ...(options.services !== undefined ? { services: options.services } : {}),
        ...(hostCallbacks !== undefined ? { hostCallbacks } : {}),
    });
}

export function registerDefaultParentJobTool(registry: ToolRegistry, options: RegisterDefaultCodingToolsOptions): void {
    if (options.asyncJobManager === undefined) return;
    registry.register(createJobToolRegistration({ jobManager: options.asyncJobManager }));
}

async function registerAskUserForHost(
    registry: ToolRegistry,
    options: RegisterDefaultCodingToolsOptions,
): Promise<void> {
    if (options.hostKind === 'noninteractive') {
        await registerAskUserTool(registry, {
            requestUserQuestion: () => Promise.resolve(''),
            nonInteractive: true,
        });
        return;
    }
    if (options.requestUserQuestion === undefined) return;
    const userInputWait = createInteractiveAskUserWaitMirror(options);
    await registerAskUserTool(registry, {
        requestUserQuestion: options.requestUserQuestion,
        ...(options.requestUserQuestions !== undefined ? { requestUserQuestions: options.requestUserQuestions } : {}),
        ...(userInputWait !== undefined ? { userInputWait } : {}),
    });
}

type InteractiveAskUserWaitMirror = {
    readonly start: (context: { readonly toolCallId: string }) => Promise<void>;
    readonly resolve: (context: { readonly toolCallId: string }) => Promise<void>;
};

function createInteractiveAskUserWaitMirror(
    options: Extract<RegisterDefaultCodingToolsOptions, { hostKind: 'interactive' }>,
): InteractiveAskUserWaitMirror | undefined {
    const mirror = options.services?.mirror;
    if (mirror === undefined || !hasUserInputWaitMethods(mirror)) return undefined;
    const sessionId = options.sessionId;
    return {
        start: (context) => mirror.startUserInputWait({ sessionId, toolCallId: context.toolCallId }),
        resolve: (context) => mirror.resolveUserInputWait({ sessionId, toolCallId: context.toolCallId }),
    };
}

function hasUserInputWaitMethods(mirror: object): mirror is {
    readonly startUserInputWait: (input: {
        readonly sessionId: string;
        readonly toolCallId: string;
    }) => Promise<void>;
    readonly resolveUserInputWait: (input: {
        readonly sessionId: string;
        readonly toolCallId: string;
    }) => Promise<void>;
} {
    return (
        'startUserInputWait' in mirror &&
        'resolveUserInputWait' in mirror &&
        typeof mirror.startUserInputWait === 'function' &&
        typeof mirror.resolveUserInputWait === 'function'
    );
}

async function registerMutationTools(
    registry: ToolRegistry,
    options: RegisterDefaultCodingToolsOptions,
): Promise<void> {
    const authority = {
        workspaceRoot: options.workspaceRoot,
        requestPermission: options.requestPermission,
    };
    await registerFileEditTool(registry, authority);
    await registerFileWriteTool(registry, authority);
    await registerFilePatchTool(registry, authority);
    await registerHashlineEditTool(registry, authority);
    await registerCommandRunTool(registry, {
        ...authority,
        ...(options.commandExecutor !== undefined ? { executor: options.commandExecutor } : {}),
    });
    if (!options.enableTrustedBash || !cliAllowsAction('bash.run')) return;
    await registerBashRunTool(registry, {
        ...authority,
        workspaceTrust: 'trusted',
        ...(options.commandExecutor !== undefined ? { executor: options.commandExecutor } : {}),
    });
    if (cliAllowsAction('interactive_bash')) {
        await registerInteractiveBashTool(registry, {
            ...authority,
            ...(options.tmuxAvailable !== undefined ? { tmuxAvailable: options.tmuxAvailable } : {}),
        });
    }
    // CLI has no stream-aware sidecar-v3 ShellSessionTransport, so shell.session stays unadvertised.
    await registerEvalTool(registry, {
        ...authority,
        projectTrustStore: options.projectTrustStore ?? new ProjectTrustStore(),
        ...(options.evalContextManagerFactory !== undefined
            ? { contextManagerFactory: options.evalContextManagerFactory }
            : {}),
    });
}
