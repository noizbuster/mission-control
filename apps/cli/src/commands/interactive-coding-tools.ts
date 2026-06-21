import {
    type AskUserQuestionRequest,
    type CommandExecutionRequest,
    type CommandExecutionResult,
    createDelegatingLspClient,
    createLspToolRegistration,
    createReadOnlyRepoToolRegistrations,
    createTaskSpawnFn,
    discoverSkills,
    type LspClient,
    LspServerManager,
    type LspServerManagerDeps,
    type McpConnectionManager,
    registerAskUserTool,
    registerAstGrepTool,
    registerBashRunTool,
    registerCommandRunTool,
    registerEvalTool,
    registerFileEditTool,
    registerFilePatchTool,
    registerFileWriteTool,
    registerGlobTool,
    registerNamespacedMcpTools,
    registerSkillTool,
    registerTaskTool,
    registerWebfetchTool,
    registerWebSearchTool,
    type SdkModelResolver,
    selectWebSearchProvider,
    type ToolInvocationSettlement,
    ToolRegistry,
    type ToolRegistryWithMcp,
    todoWriteToolRegistration,
} from '@mission-control/core';
import type { AbgNodeModelOptions, ModelProviderSelection, PermissionRequest } from '@mission-control/protocol';
import { type AgentEvent, type ToolCall, ToolResultSchema } from '@mission-control/protocol';
import { cliAllowsAction } from './cli-permission-policy.js';
import type { ApprovalLevel } from './approval-level.js';
import type { InteractiveApprovalBroker } from './interactive-approval-broker.js';
import type { ChatOutput } from './interactive-chat-io.js';
import { renderToolPreview } from './interactive-coding-tool-preview.js';

export type InteractiveToolOptions = {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly output: ChatOutput;
    readonly emitEvent: (event: AgentEvent) => void;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
    readonly enableTrustedBash?: boolean;
    /**
     * When set, the `task` subagent tool is registered with a real spawn closure built from
     * `spawnChildCodingAgent` (the child surface derives from THIS registry). Omit to leave the
     * `task` tool absent (no mock/fallback).
     */
    readonly resolveSdkModel?: SdkModelResolver;
    /**
     * An already-connected MCP connection manager to reuse across turns (session-scoped).
     * When omitted, the factory creates a new manager and connects eagerly.
     */
    readonly mcpConnectionManager?: McpConnectionManager;
    /**
     * LSP seam: when a real `LspClient` is injected, the `lsp` tool is registered
     * with that client (test injection path). When omitted, the registry
     * auto-detects available language servers via `LspServerManager` and registers
     * the `lsp` tool with a delegating client when at least one server command
     * resolves on PATH.
     */
    readonly lspClient?: LspClient;
    /**
     * Test seam for the auto-detection path: inject a mock `commandExists` /
     * `createClient` so tests control server availability without spawning real
     * processes. Ignored when `lspClient` is explicitly provided.
     */
    readonly lspServerManagerDeps?: LspServerManagerDeps;
    /**
     * `ask_user` tool callback: resolves with the user's answer to a model-posed question. When
     * omitted, the `ask_user` tool is not registered (no host surface to ask the user). The
     * interactive TUI wires this to the Ink question overlay.
     */
    readonly requestUserQuestion?: (request: AskUserQuestionRequest) => Promise<string>;
    readonly approvalLevel?: ApprovalLevel;
};

export async function createInteractiveToolRegistry(
    options: InteractiveToolOptions,
    approvals: InteractiveApprovalBroker,
): Promise<ToolRegistryWithMcp> {
    const registry = new ToolRegistry();
    const readTools = await createReadOnlyRepoToolRegistrations({
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
    });
    registry.register(readTools[3]);
    registry.register(readTools[4]);
    registry.register(readTools[5]);
    registry.register(readTools[6]);
    await registerGlobTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
    });
    await registerAstGrepTool(registry, { workspaceRoot: options.workspaceRoot });
    registry.register(todoWriteToolRegistration);
    const skillDiscovery = await discoverSkills({ workspaceRoot: options.workspaceRoot });
    registerSkillTool(registry, { skills: skillDiscovery.skills });
    await registerWebfetchTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
    });
    if (selectWebSearchProvider() !== undefined) {
        await registerWebSearchTool(registry, { sessionId: options.sessionId });
    }
    if (options.requestUserQuestion !== undefined) {
        await registerAskUserTool(registry, { requestUserQuestion: options.requestUserQuestion });
    }
    await registerFileEditTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
    });
    await registerFileWriteTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
    });
    await registerFilePatchTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
    });
    await registerCommandRunTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
        ...(options.commandExecutor !== undefined ? { executor: options.commandExecutor } : {}),
    });
    if (options.enableTrustedBash === true && cliAllowsAction('bash.run')) {
        await registerBashRunTool(registry, {
            workspaceRoot: options.workspaceRoot,
            workspaceTrust: 'trusted',
            requestPermission: approvals.requestPermission,
            ...(options.commandExecutor !== undefined ? { executor: options.commandExecutor } : {}),
        });
        await registerEvalTool(registry, { workspaceRoot: options.workspaceRoot });
    }
    const resolveSdkModel = options.resolveSdkModel;
    if (resolveSdkModel !== undefined) {
        const selection = options.modelProviderSelection;
        const model: AbgNodeModelOptions = {
            providerID: selection.providerID,
            modelID: selection.modelID,
            ...(selection.variantID !== undefined ? { variantID: selection.variantID } : {}),
        };
        await registerTaskTool(registry, {
            workspaceRoot: options.workspaceRoot,
            requestPermission: approvals.requestPermission,
            spawn: createTaskSpawnFn({
                resolveSdkModel,
                model,
                parentToolRegistry: registry,
                parentSessionId: options.sessionId,
            }),
        });
    }
    const mcpConnectionManager = await registerNamespacedMcpTools(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: approvals.requestPermission,
        ...(options.mcpConnectionManager !== undefined ? { mcpConnectionManager: options.mcpConnectionManager } : {}),
    });
    // LSP seam: prefer an explicitly injected client (test injection); otherwise
    // auto-detect available language servers and register the `lsp` tool with a
    // delegating client when at least one server command resolves on PATH.
    const lspGuideline =
        'Use lsp for compiler-grade diagnostics, hover, go-to-definition, references, ' +
        'symbol outlines, implementation, type definition, and incoming call hierarchy ' +
        'instead of guessing types from source text.';
    if (options.lspClient !== undefined) {
        registry.register(createLspToolRegistration({ client: options.lspClient, guideline: lspGuideline }));
    } else {
        const lspManager = new LspServerManager({ workspaceRoot: options.workspaceRoot }, options.lspServerManagerDeps);
        const availableServers = await lspManager.detectAvailableServers();
        if (availableServers.length > 0) {
            registry.register(
                createLspToolRegistration({ client: createDelegatingLspClient(lspManager), guideline: lspGuideline }),
            );
        }
    }
    return { registry, mcpConnectionManager };
}

export async function preflightInteractiveToolCall(
    toolCall: ToolCall,
    options: InteractiveToolOptions,
    approvals: InteractiveApprovalBroker,
): Promise<ToolInvocationSettlement | undefined> {
    if (toolCall.toolName === 'file.write' && parseFileWritePreview(toolCall.argumentsJson) === undefined) {
        return undefined;
    }
    await renderToolPreview(toolCall, options.output, options.workspaceRoot);
    const request = approvalRequestForToolCall(toolCall, options.workspaceRoot);
    if (request === undefined) {
        return undefined;
    }
    const decision = await approvals.requestPermission(request);
    if (decision.status === 'allow') {
        approvals.primeApproval(request.id, decision.reason);
        return undefined;
    }
    const messagePrefix = decision.status === 'deny' ? 'approval_denied' : 'approval_required';
    const message = `${messagePrefix}: ${decision.reason ?? 'interactive CLI approval'}`;
    const result = ToolResultSchema.parse({
        toolCallId: toolCall.toolCallId,
        status: 'failed',
        error: {
            code: 'tool_failed',
            message,
            retryable: false,
        },
    });
    return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        result,
        events: [
            {
                type: 'tool.failed',
                timestamp: new Date().toISOString(),
                taskId: toolCall.toolCallId,
                message: `tool failed: ${toolCall.toolName}`,
                nativeSidecarStatus: 'mock',
                modelProviderSelection: options.modelProviderSelection,
                toolResult: result,
            },
        ],
    };
}

function approvalRequestForToolCall(toolCall: ToolCall, workspaceRoot: string): PermissionRequest | undefined {
    if (toolCall.toolName.startsWith('mcp__')) {
        return {
            id: `permission_${toolCall.toolCallId}`,
            action: 'mcp',
            reason: `MCP tool: ${toolCall.toolName}`,
            permission: {
                kind: 'network',
                patterns: [toolCall.toolName],
                workspaceRoot,
            },
        };
    }
    if (toolCall.toolName === 'webfetch') {
        const url = parseWebfetchUrl(toolCall.argumentsJson);
        if (url === undefined) {
            return undefined;
        }
        return {
            id: `permission_${toolCall.toolCallId}`,
            action: 'webfetch',
            reason: `fetch url: ${url}`,
            permission: {
                kind: 'network',
                patterns: [url],
                workspaceRoot,
            },
        };
    }
    if (toolCall.toolName === 'web_search') {
        const query = parseWebSearchQuery(toolCall.argumentsJson);
        if (query === undefined) {
            return undefined;
        }
        return {
            id: `permission_${toolCall.toolCallId}`,
            action: 'web_search',
            reason: `web search query: ${query}`,
            permission: {
                kind: 'network',
                patterns: [query],
                workspaceRoot,
            },
        };
    }
    if (toolCall.toolName === 'task') {
        const description = parseTaskDescription(toolCall.argumentsJson);
        if (description === undefined) {
            return undefined;
        }
        return {
            id: `permission_${toolCall.toolCallId}`,
            action: 'task',
            reason: `delegate sub-task: ${description}`,
            permission: {
                kind: 'subagent',
                patterns: [description],
                workspaceRoot,
            },
        };
    }
    if (toolCall.toolName === 'command.run') {
        const input = parseCommandRunPreview(toolCall.argumentsJson);
        if (input === undefined) {
            return undefined;
        }
        const command = [input.command, ...input.args].join(' ');
        return {
            id: `permission_${toolCall.toolCallId}`,
            action: 'command.run',
            reason: `run command: ${command}`,
            permission: {
                kind: 'bash',
                patterns: [command],
                workspaceRoot,
            },
        };
    }
    if (toolCall.toolName === 'bash.run') {
        const input = parseBashRunPreview(toolCall.argumentsJson);
        if (input === undefined) {
            return undefined;
        }
        return {
            id: `permission_${toolCall.toolCallId}`,
            action: 'bash.run',
            reason: `run trusted bash: ${input.commandLine}`,
            permission: {
                kind: 'bash',
                patterns: [input.commandLine],
                workspaceRoot,
            },
        };
    }
    if (toolCall.toolName === 'eval') {
        return {
            id: `permission_${toolCall.toolCallId}`,
            action: 'eval',
            reason: 'execute code in sandbox',
            permission: {
                kind: 'bash',
                patterns: ['eval'],
                workspaceRoot,
            },
        };
    }
    if (toolCall.toolName === 'file.edit') {
        const input = parseFileEditPreview(toolCall.argumentsJson);
        if (input === undefined) {
            return undefined;
        }
        return {
            id: `permission_${toolCall.toolCallId}`,
            action: 'file.edit',
            reason: `edit exact text in ${input.path}`,
            permission: {
                kind: 'edit',
                patterns: [input.path],
                workspaceRoot,
            },
        };
    }
    if (toolCall.toolName === 'file.patch') {
        const patch = parsePatchPreview(toolCall.argumentsJson);
        const paths = patch === undefined ? [] : patchTargetPaths(patch);
        if (paths.length === 0) {
            return undefined;
        }
        return {
            id: `permission_${toolCall.toolCallId}`,
            action: 'file.patch',
            reason: `apply patch to ${paths.join(', ')}`,
            permission: {
                kind: 'patch',
                patterns: [...paths],
                workspaceRoot,
            },
        };
    }
    if (toolCall.toolName === 'file.write') {
        const input = parseFileWritePreview(toolCall.argumentsJson);
        if (input === undefined) {
            return undefined;
        }
        return {
            id: `permission_${toolCall.toolCallId}`,
            action: 'file.write',
            reason:
                input.createParents === true
                    ? `write full contents to ${input.path} and create parent directories`
                    : `write full contents to ${input.path}`,
            permission: {
                kind: 'write',
                patterns: [input.path],
                workspaceRoot,
            },
        };
    }
    return undefined;
}

function parseCommandRunPreview(
    argumentsJson: string,
): { readonly command: string; readonly args: readonly string[] } | undefined {
    const value = parseArguments(argumentsJson);
    if (!isRecord(value) || typeof value.command !== 'string' || value.command.length === 0) {
        return undefined;
    }
    const args = value.args;
    if (args === undefined) {
        return { command: value.command, args: [] };
    }
    if (!Array.isArray(args) || !args.every((entry) => typeof entry === 'string')) {
        return undefined;
    }
    return { command: value.command, args: [...args] };
}

function parsePatchPreview(argumentsJson: string): string | undefined {
    const value = parseArguments(argumentsJson);
    return isRecord(value) && typeof value.patch === 'string' && value.patch.length > 0 ? value.patch : undefined;
}

function parseBashRunPreview(
    argumentsJson: string,
): { readonly commandLine: string; readonly cwd?: string } | undefined {
    const value = parseArguments(argumentsJson);
    if (!isRecord(value) || typeof value.commandLine !== 'string' || value.commandLine.length === 0) {
        return undefined;
    }
    if (value.cwd !== undefined && (typeof value.cwd !== 'string' || value.cwd.length === 0)) {
        return undefined;
    }
    return {
        commandLine: value.commandLine,
        ...(value.cwd !== undefined ? { cwd: value.cwd } : {}),
    };
}

function parseFileEditPreview(argumentsJson: string):
    | {
          readonly path: string;
          readonly oldText: string;
          readonly newText: string;
          readonly occurrence?: number;
          readonly replaceAll?: boolean;
      }
    | undefined {
    const value = parseArguments(argumentsJson);
    if (
        !isRecord(value) ||
        typeof value.path !== 'string' ||
        value.path.length === 0 ||
        typeof value.oldText !== 'string' ||
        value.oldText.length === 0 ||
        typeof value.newText !== 'string'
    ) {
        return undefined;
    }
    if (value.occurrence !== undefined && !isPositiveInteger(value.occurrence)) {
        return undefined;
    }
    if (value.replaceAll !== undefined && typeof value.replaceAll !== 'boolean') {
        return undefined;
    }
    if (value.occurrence !== undefined && value.replaceAll !== undefined) {
        return undefined;
    }
    if (value.oldText === value.newText) {
        return undefined;
    }
    return {
        path: value.path,
        oldText: value.oldText,
        newText: value.newText,
        ...(value.occurrence !== undefined ? { occurrence: value.occurrence } : {}),
        ...(value.replaceAll !== undefined ? { replaceAll: value.replaceAll } : {}),
    };
}

function parseWebfetchUrl(argumentsJson: string): string | undefined {
    const value = parseArguments(argumentsJson);
    if (!isRecord(value) || typeof value.url !== 'string' || value.url.length === 0) {
        return undefined;
    }
    return value.url;
}

function parseWebSearchQuery(argumentsJson: string): string | undefined {
    const value = parseArguments(argumentsJson);
    if (!isRecord(value) || typeof value.query !== 'string' || value.query.length === 0) {
        return undefined;
    }
    return value.query;
}

function parseTaskDescription(argumentsJson: string): string | undefined {
    const value = parseArguments(argumentsJson);
    if (!isRecord(value) || typeof value.description !== 'string' || value.description.length === 0) {
        return undefined;
    }
    return value.description;
}

function parseFileWritePreview(
    argumentsJson: string,
): { readonly path: string; readonly content: string; readonly createParents: boolean } | undefined {
    const value = parseArguments(argumentsJson);
    if (
        !isRecord(value) ||
        typeof value.path !== 'string' ||
        value.path.length === 0 ||
        typeof value.content !== 'string'
    ) {
        return undefined;
    }
    if (value.createParents !== undefined && typeof value.createParents !== 'boolean') {
        return undefined;
    }
    if (isBinaryWriteContent(value.content)) {
        return undefined;
    }
    return {
        path: value.path,
        content: value.content,
        createParents: value.createParents === true,
    };
}

function isBinaryWriteContent(content: string): boolean {
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length === 0) {
        return false;
    }
    let suspicious = 0;
    for (const byte of bytes) {
        if (byte === 0) {
            return true;
        }
        if (byte < 9 || (byte > 13 && byte < 32)) {
            suspicious += 1;
        }
    }
    return suspicious / bytes.length > 0.3;
}

function patchTargetPaths(patch: string): readonly string[] {
    const paths = new Set<string>();
    for (const line of patch.split('\n')) {
        const diffMatch = /^diff --git a\/.+ b\/(.+)$/.exec(line);
        if (diffMatch?.[1] !== undefined) {
            paths.add(diffMatch[1]);
            continue;
        }
        const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
        if (fileMatch?.[1] !== undefined) {
            paths.add(fileMatch[1]);
        }
    }
    return [...paths];
}

function parseArguments(argumentsJson: string): unknown {
    try {
        return JSON.parse(argumentsJson);
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is {
    readonly args?: unknown;
    readonly command?: unknown;
    readonly content?: unknown;
    readonly cwd?: unknown;
    readonly createParents?: unknown;
    readonly commandLine?: unknown;
    readonly description?: unknown;
    readonly newText?: unknown;
    readonly occurrence?: unknown;
    readonly oldText?: unknown;
    readonly patch?: unknown;
    readonly path?: unknown;
    readonly query?: unknown;
    readonly replaceAll?: unknown;
    readonly url?: unknown;
} {
    return typeof value === 'object' && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
