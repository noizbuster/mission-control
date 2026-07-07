import type { LspClient, LspServerManagerDeps, SdkModelResolver } from '@mission-control/core';
import type {
    ModelProviderSelection,
    PermissionDecision,
    PermissionRequest,
    ToolCall,
} from '@mission-control/protocol';
import type { InteractiveApprovalBroker } from './interactive-approval-broker.js';
import type { InteractiveToolOptions } from './interactive-coding-tools.js';

export const noLspServers: LspServerManagerDeps = { commandExists: async () => false };

export function fakeBroker(): InteractiveApprovalBroker {
    return {
        requestApproval: async (request) => ({
            requestId: request.id,
            status: 'deny',
            reason: 'test broker',
        }),
        requestPermission: async (request) => ({
            requestId: request.id,
            status: 'allow',
            reason: 'test broker',
        }),
        primeApproval: () => undefined,
        answer: () => false,
        cancel: () => undefined,
        hasPending: () => false,
        setApprovalLevel: () => undefined,
    };
}

export function toolOptions(
    output: InteractiveToolOptions['output'],
    workspaceRoot = '/workspace',
    resolveSdkModel?: SdkModelResolver,
    lspClient?: LspClient,
): InteractiveToolOptions {
    const modelProviderSelection: ModelProviderSelection = { providerID: 'local', modelID: 'local-echo' };
    return {
        workspaceRoot,
        sessionId: 'session_interactive_tools',
        modelProviderSelection,
        output,
        emitEvent: () => undefined,
        ...(resolveSdkModel !== undefined ? { resolveSdkModel } : {}),
        ...(lspClient !== undefined ? { lspClient } : {}),
        lspServerManagerDeps: noLspServers,
    };
}

export function toolCall(toolName: string, toolCallId: string, input: Readonly<Record<string, unknown>>): ToolCall {
    return {
        toolCallId,
        toolName,
        argumentsJson: JSON.stringify(input),
    };
}

export const throwingResolver: SdkModelResolver = () => {
    throw new Error('resolveSdkModel should not be invoked during registry construction');
};

export const allowAllPermission = async (request: PermissionRequest): Promise<PermissionDecision> => ({
    requestId: request.id,
    status: 'allow',
    reason: 'non-interactive test fake',
});
